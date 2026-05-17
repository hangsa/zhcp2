"""Glyph contour search index for font de-obfuscation.

Exact hash lookup (O(1) via SQLite) and exact flat L2 KNN search
via FAISS IndexFlatL2. For the reference library size (~36k vectors)
flat search is <1ms/query — accurate and avoids IVF cluster-miss issues.
"""

import json
import logging
import math
import sqlite3
from pathlib import Path

import faiss
import numpy as np

logger = logging.getLogger(__name__)

# KNN per-point distance threshold: aligned with PRD ε=2.5 in [0,100] space.
# FAISS L2 distance is over all coordinate dimensions; we normalize by
# (n_points × 2) dimension pairs to get per-coordinate RMS distance.
PER_POINT_DIST_THRESHOLD = 2.5


class FAISSHashIndex:
    """Glyph contour index with exact hash lookup and flat L2 KNN search."""

    def __init__(self, db_path: str | Path, index_path: str | Path | None = None):
        db_path = Path(db_path)

        if not db_path.exists():
            raise FileNotFoundError(f"Database not found: {db_path}")

        self._conn = sqlite3.connect(str(db_path))
        self._conn.row_factory = sqlite3.Row

        # Build id → (char, unicode) lookup from DB
        self._id_map: dict[int, tuple[str, int]] = {}
        self._hash_index: dict[str, list[int]] = {}  # hash → [id, ...]
        self._load_maps()

        # Lazy-built flat L2 index and its separate id_map
        self._flat_index: faiss.IndexFlatL2 | None = None
        self._flat_id_map: dict[int, tuple[str, int]] = {}

        # IVF index kept for backward-compatibility (not used for search)
        self._ivf_index: faiss.IndexIVFFlat | None = None
        if index_path is not None:
            index_path = Path(index_path)
            if index_path.exists():
                self._ivf_index = faiss.read_index(str(index_path))
                logger.info("IVF index loaded (not used for search): %d vectors",
                           self._ivf_index.ntotal)

    def _load_maps(self) -> None:
        """Load id→char and hash→ids maps from DB into memory."""
        rows = self._conn.execute(
            "SELECT id, char, unicode, hash FROM glyph_hashes"
        ).fetchall()
        for row in rows:
            self._id_map[row["id"]] = (row["char"], row["unicode"])
            self._hash_index.setdefault(row["hash"], []).append(row["id"])
        logger.info(
            "Loaded %d entries, %d unique hashes",
            len(self._id_map),
            len(self._hash_index),
        )

    @property
    def n_total(self) -> int:
        if self._flat_index is not None:
            return self._flat_index.ntotal
        return len(self._id_map)

    def close(self) -> None:
        """Close the database connection."""
        self._conn.close()

    # ---- Exact match ----

    def exact_match(self, glyph_hash: str) -> str | None:
        """Look up glyph by normalized MD5 hash. Returns character or None."""
        ids = self._hash_index.get(glyph_hash, [])
        if ids:
            return self._id_map[ids[0]][0]
        return None

    # ---- KNN search ----

    def knn_search(
        self, vector: np.ndarray, k: int = 3
    ) -> list[tuple[str, float]]:
        """Exact flat L2 KNN search. Returns [(char, L2_distance), ...].

        Uses IndexFlatL2 — brute-force over all vectors. For our reference
        library size (~36k vectors × 1024 dims), flat search is <1ms,
        well within the 5ms/char budget.
        """
        if self._flat_index is None:
            self._flat_index = self._build_flat_index()

        if vector.ndim == 1:
            vector = vector.reshape(1, -1)

        distances, indices = self._flat_index.search(vector.astype(np.float32), k)

        results: list[tuple[str, float]] = []
        for dist, idx in zip(distances[0], indices[0]):
            if idx >= 0 and idx in self._flat_id_map:
                char = self._flat_id_map[idx][0]
                results.append((char, float(dist)))
        return results

    def _build_flat_index(self) -> faiss.IndexFlatL2:
        """Build flat L2 index from database vectors.

        Uses a separate id_map (_flat_id_map) so exact_match() via
        _hash_index/_id_map is not corrupted by the reindexing.
        """
        rows = self._conn.execute(
            "SELECT id, coords_blob FROM glyph_hashes ORDER BY id"
        ).fetchall()

        n = len(rows)
        dim = 1024  # 512 max_points × 2 coordinates
        flat = faiss.IndexFlatL2(dim)
        vectors = np.zeros((n, dim), dtype=np.float32)

        # Import here to avoid circular imports
        from engine.glyph_normalizer import coords_to_vector

        for i, row in enumerate(rows):
            if row["coords_blob"]:
                coord_list = json.loads(row["coords_blob"])
                coords = [(c[0], c[1], c[2]) for c in coord_list]
                vectors[i] = coords_to_vector(coords, max_points=512)

        flat.add(vectors)
        self._flat_id_map = {}
        for i, row in enumerate(rows):
            self._flat_id_map[i] = (
                self._id_map[row["id"]][0],
                self._id_map[row["id"]][1],
            )
        logger.info("Built flat L2 index with %d vectors", n)
        return flat

    # ---- Per-point distance normalization ----

    @staticmethod
    def per_point_distance(faiss_l2_dist: float, n_query_points: int) -> float:
        """Convert FAISS L2 distance to per-coordinate RMS distance.

        FAISS L2 distance = sum of squared differences across all dimensions.
        Each point contributes 2 dimensions (x, y).
        per_point_dist = sqrt(faiss_l2 / (n_points * 2))
        """
        dims = n_query_points * 2
        if dims <= 0:
            return float("inf")
        return math.sqrt(faiss_l2_dist / dims)


def distance_to_confidence(dist: float, sigma: float = 5.0) -> float:
    """Convert per-point Euclidean distance to [0,1] confidence score."""
    return math.exp(-dist / sigma)
