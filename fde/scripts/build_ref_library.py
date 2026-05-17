#!/usr/bin/env python3
"""Build reference glyph library v0.

Extracts normalized contour hashes from reference fonts for all target
characters, stores them in SQLite, and builds a FAISS IVF index for
approximate nearest-neighbor search.

Usage:
    python scripts/build_ref_library.py
    python scripts/build_ref_library.py --chars-file custom_chars.txt
    python scripts/build_ref_library.py --rebuild-index
"""

import argparse
import hashlib
import json
import logging
import sqlite3
import sys
from pathlib import Path

import numpy as np
from fontTools.ttLib import TTFont

# Ensure fde package is importable
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from engine.glyph_normalizer import (
    extract_raw_coordinates,
    normalize_glyph,
    coords_to_vector,
)

logger = logging.getLogger(__name__)

# Default paths
REPO_ROOT = Path(__file__).resolve().parent.parent
FONTS_DIR = REPO_ROOT / "data" / "reference" / "fonts"
DB_DIR = REPO_ROOT / "data" / "reference" / "db"
DB_PATH = DB_DIR / "glyphs.db"
FAISS_PATH = DB_DIR / "faiss_index.faiss"
CHARS_FILE = REPO_ROOT / "data" / "reference" / "target_chars.txt"

# FAISS IVF parameters
IVF_NLIST = 100  # Number of inverted list clusters
IVF_NPROBE = 10  # Clusters to probe during search
VECTOR_DIM = 1024  # max_points * 2 (512 coord pairs)


def generate_charset() -> list[str]:
    """Generate the target character set: GB2312 level 1+2, CJK-ExtA, punctuation."""
    chars: list[str] = []

    # GB2312 Level 1 (3755 chars, most common)
    # Range: 0xB0A1 - 0xD7F9 in GB2312 encoding
    for hi in range(0xB0, 0xD8):
        for lo in range(0xA1, 0xFF):
            try:
                gb_bytes = bytes([hi, lo])
                ch = gb_bytes.decode("gb2312")
                if ch not in chars:
                    chars.append(ch)
            except (UnicodeDecodeError, UnicodeError):
                continue

    # GB2312 Level 2 (3008 chars, less common)
    for hi in range(0xD8, 0xF8):
        for lo in range(0xA1, 0xFF):
            try:
                gb_bytes = bytes([hi, lo])
                ch = gb_bytes.decode("gb2312")
                if ch not in chars:
                    chars.append(ch)
            except (UnicodeDecodeError, UnicodeError):
                continue

    # CJK Ext-A subset: common name/location characters (U+3400-U+4DBF)
    # Target ~500 chars, sampled for most likely article occurrence
    for cp in range(0x3400, 0x4DC0, 3):  # Every 3rd character
        ch = chr(cp)
        if ch not in chars:
            chars.append(ch)

    # Common CJK punctuation
    extra_punct = (
        "　、。，〃．《》「」"
        "『』〈〉〆〇【】〔〕"
        "！（）—―‘’“”…"
        "–～／［］"
    )
    for ch in extra_punct:
        if ch not in chars:
            chars.append(ch)

    logger.info("Generated %d target characters", len(chars))
    return chars


def save_charset(chars: list[str], path: Path) -> None:
    """Write character set to file, one per line."""
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        for ch in chars:
            f.write(ch + "\n")
    logger.info("Saved %d characters to %s", len(chars), path)


def load_charset(path: Path) -> list[str]:
    """Load character set from file."""
    chars: list[str] = []
    with open(path, encoding="utf-8") as f:
        for line in f:
            ch = line.strip()
            if ch:
                chars.append(ch)
    logger.info("Loaded %d characters from %s", len(chars), path)
    return chars


def find_font_files(fonts_dir: Path) -> list[Path]:
    """Find all .ttf/.otf/.ttc font files in the reference fonts directory."""
    fonts: list[Path] = []
    for ext in ("*.ttf", "*.otf", "*.ttc"):
        fonts.extend(fonts_dir.glob(ext))
        fonts.extend(fonts_dir.glob(ext.upper()))
    logger.info("Found %d font files in %s", len(fonts), fonts_dir)
    return fonts


def init_database(db_path: Path) -> sqlite3.Connection:
    """Initialize SQLite database with schema."""
    db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(db_path))
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")

    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS glyph_hashes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            char TEXT NOT NULL,
            unicode INTEGER NOT NULL,
            hash TEXT NOT NULL,
            font_name TEXT NOT NULL,
            coords_blob BLOB,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
        """
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_hash ON glyph_hashes(hash)"
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_char ON glyph_hashes(char)"
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_unicode ON glyph_hashes(unicode)"
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS font_metadata (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            font_name TEXT NOT NULL UNIQUE,
            font_path TEXT NOT NULL,
            num_glyphs INTEGER,
            format TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS build_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            build_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            total_chars INTEGER,
            total_hashes INTEGER,
            fonts_used INTEGER,
            coverage_ratio REAL,
            faiss_index_size INTEGER
        )
        """
    )
    conn.commit()
    return conn


def process_font(
    font_path: Path,
    chars: list[str],
    conn: sqlite3.Connection,
    tolerance: float = 1.0,
) -> int:
    """Extract contours from one font file (handles .ttf/.otf/.ttc) and insert into DB.

    For .ttc collections, processes all font faces.
    Returns total number of glyphs successfully processed.
    """
    base_name = font_path.stem
    is_ttc = font_path.suffix.lower() == ".ttc"
    total_count = 0

    # Determine number of faces
    face_numbers = [0]
    if is_ttc:
        # Probe faces: open sequentially until failure
        max_faces = 1
        for fn in range(1, 16):
            try:
                probe = TTFont(str(font_path), fontNumber=fn)
                max_faces = fn + 1
            except Exception:
                break
        face_numbers = list(range(max_faces))

    for face_num in face_numbers:
        if is_ttc:
            try:
                font = TTFont(str(font_path), fontNumber=face_num)
            except Exception:
                logger.warning("Failed to open font face %d: %s", face_num, font_path)
                continue
            # Include face number in font name for TTC collections
            font_name = f"{base_name}_face{face_num}"
        else:
            font_name = base_name
            try:
                font = TTFont(str(font_path), fontNumber=0)
            except Exception:
                logger.warning("Failed to open font: %s", font_path)
                continue

        cmap = font.getBestCmap()
        if not cmap:
            logger.warning("No cmap table in font: %s", font_name)
            continue

        count = 0
        for ch in chars:
            cp = ord(ch)
            glyph_name = cmap.get(cp)
            if glyph_name is None:
                continue

            try:
                raw_coords = extract_raw_coordinates(font, glyph_name)
            except Exception:
                logger.debug("Failed to extract coords for %s in %s", ch, font_name)
                continue

            if not raw_coords:
                continue

            contour = normalize_glyph(raw_coords, tolerance)

            coords_blob = json.dumps(
                [[x, y, f] for x, y, f in contour.coords]
            ).encode("utf-8")

            conn.execute(
                "INSERT OR REPLACE INTO glyph_hashes "
                "(char, unicode, hash, font_name, coords_blob) "
                "VALUES (?, ?, ?, ?, ?)",
                (ch, cp, contour.hash, font_name, coords_blob),
            )
            count += 1

        conn.commit()

        conn.execute(
            "INSERT OR REPLACE INTO font_metadata "
            "(font_name, font_path, num_glyphs, format) "
            "VALUES (?, ?, ?, ?)",
            (font_name, str(font_path), count, font_path.suffix),
        )
        conn.commit()

        coverage = count / len(chars) * 100 if chars else 0
        logger.info(
            "  %s: %d/%d glyphs (%.1f%% coverage)",
            font_name,
            count,
            len(chars),
            coverage,
        )
        total_count += count

    return total_count


def build_faiss_index(conn: sqlite3.Connection, index_path: Path) -> int:
    """Build FAISS IVF index from all stored hashes."""
    import faiss

    rows = conn.execute(
        "SELECT id, char, unicode FROM glyph_hashes"
    ).fetchall()

    if not rows:
        logger.error("No glyph hashes in database to build index")
        return 0

    vectors = np.zeros((len(rows), VECTOR_DIM), dtype=np.float32)
    id_map: dict[int, tuple[str, int]] = {}

    for i, (row_id, char, unicode) in enumerate(rows):
        # Use padded vector for FAISS
        vec = np.zeros(VECTOR_DIM, dtype=np.float32)
        # We need the original coordinates to build the vector
        # Fetch coords_blob and convert
        coords_row = conn.execute(
            "SELECT coords_blob FROM glyph_hashes WHERE id = ?",
            (row_id,),
        ).fetchone()
        if coords_row and coords_row[0]:
            coord_list = json.loads(coords_row[0])
            # coords_blob is [[x, y, flag], ...]
            coords = [(c[0], c[1], c[2]) for c in coord_list]
            vec = coords_to_vector(coords, max_points=512)
        vectors[i] = vec
        id_map[i] = (char, unicode)

    # Build IVF index
    quantizer = faiss.IndexFlatL2(VECTOR_DIM)
    index = faiss.IndexIVFFlat(quantizer, VECTOR_DIM, IVF_NLIST, faiss.METRIC_L2)

    index.train(vectors)
    index.add(vectors)
    # Set default nprobe
    faiss.ParameterSpace().set_index_parameter(index, "nprobe", IVF_NPROBE)

    faiss.write_index(index, str(index_path))

    logger.info("FAISS index built: %d vectors, saved to %s", len(rows), index_path)
    return len(rows)


def compute_coverage(conn: sqlite3.Connection, total_chars: int) -> dict:
    """Compute coverage statistics."""
    # Characters covered by at least one font
    covered = conn.execute(
        "SELECT COUNT(DISTINCT char) FROM glyph_hashes"
    ).fetchone()[0]

    # Characters covered by 3+ fonts
    well_covered = conn.execute(
        """
        SELECT COUNT(*) FROM (
            SELECT char, COUNT(DISTINCT font_name) as n_fonts
            FROM glyph_hashes
            GROUP BY char
            HAVING n_fonts >= 3
        )
        """
    ).fetchone()[0]

    # Missing characters (in target set but not in DB)
    return {
        "total_target": total_chars,
        "covered": covered,
        "coverage_ratio": covered / total_chars if total_chars else 0,
        "well_covered": well_covered,
        "well_covered_ratio": well_covered / total_chars if total_chars else 0,
        "missing": total_chars - covered,
    }


def main() -> None:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [%(levelname)s] %(message)s",
        datefmt="%H:%M:%S",
    )

    parser = argparse.ArgumentParser(
        description="Build reference glyph library for FDE"
    )
    parser.add_argument(
        "--chars-file",
        type=Path,
        default=CHARS_FILE,
        help="File with characters to process (one per line)",
    )
    parser.add_argument(
        "--fonts-dir",
        type=Path,
        default=FONTS_DIR,
        help="Directory containing reference font files",
    )
    parser.add_argument(
        "--db-path",
        type=Path,
        default=DB_PATH,
        help="SQLite database path",
    )
    parser.add_argument(
        "--faiss-path",
        type=Path,
        default=FAISS_PATH,
        help="FAISS index file path",
    )
    parser.add_argument(
        "--tolerance",
        type=float,
        default=1.0,
        help="Coordinate quantization tolerance",
    )
    parser.add_argument(
        "--rebuild-index",
        action="store_true",
        help="Rebuild FAISS index from existing DB",
    )
    parser.add_argument(
        "--generate-charset",
        action="store_true",
        help="Only generate character set file and exit",
    )
    args = parser.parse_args()

    # Generate or load character set
    if args.chars_file.exists() and not args.generate_charset:
        chars = load_charset(args.chars_file)
    else:
        chars = generate_charset()
        save_charset(chars, args.chars_file)

    if args.generate_charset:
        return

    # Find fonts
    fonts = find_font_files(args.fonts_dir)
    if not fonts:
        logger.warning("No fonts found in %s. Add reference fonts and re-run.", args.fonts_dir)
        logger.info(
            "Suggested fonts to download:\n"
            "  - Source Han Sans SC (思源黑体): "
            "https://github.com/adobe-fonts/source-han-sans/releases\n"
            "  - Source Han Serif SC (思源宋体): "
            "https://github.com/adobe-fonts/source-han-serif/releases\n"
            "  - Download OTF or TTF format, place in %s",
            args.fonts_dir,
        )
        # Still create DB schema even without fonts
        conn = init_database(args.db_path)
        conn.close()
        return

    # Initialize database
    conn = init_database(args.db_path)

    # Process each font
    logger.info("Processing %d fonts for %d target characters...", len(fonts), len(chars))
    total_hashes = 0
    for font_path in sorted(fonts):
        n = process_font(font_path, chars, conn, args.tolerance)
        total_hashes += n

    # Build FAISS index
    index_size = 0
    if total_hashes > 0:
        index_size = build_faiss_index(conn, args.faiss_path)

    # Compute coverage
    coverage = compute_coverage(conn, len(chars))

    # Record build log
    conn.execute(
        "INSERT INTO build_log "
        "(total_chars, total_hashes, fonts_used, coverage_ratio, faiss_index_size) "
        "VALUES (?, ?, ?, ?, ?)",
        (
            len(chars),
            total_hashes,
            len(fonts),
            coverage["coverage_ratio"],
            index_size,
        ),
    )
    conn.commit()

    # Summary
    logger.info("=" * 50)
    logger.info("Build complete!")
    logger.info("  Total characters targeted: %d", coverage["total_target"])
    logger.info("  Total hashes stored:      %d", total_hashes)
    logger.info("  Fonts processed:          %d", len(fonts))
    logger.info(
        "  Coverage:                 %d/%d (%.1f%%)",
        coverage["covered"],
        coverage["total_target"],
        coverage["coverage_ratio"] * 100,
    )
    logger.info(
        "  Well-covered (3+ fonts):  %d (%.1f%%)",
        coverage["well_covered"],
        coverage["well_covered_ratio"] * 100,
    )
    logger.info("  Missing characters:       %d", coverage["missing"])
    logger.info("  FAISS index size:         %d vectors", index_size)
    logger.info("  Database:                 %s", args.db_path)
    logger.info("  FAISS index:              %s", args.faiss_path)

    if coverage["coverage_ratio"] < 0.99:
        logger.warning(
            "Coverage below 99%% — add more reference fonts to cover missing %d characters",
            coverage["missing"],
        )

    conn.close()


if __name__ == "__main__":
    main()
