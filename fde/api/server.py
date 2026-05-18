"""FDE REST API — FastAPI application.

Endpoints:
    GET  /health          — service health and index status
    POST /api/v1/decode   — decode a page with obfuscated fonts
"""

import base64
import binascii
import json
import logging
import os
import time
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

logger = logging.getLogger(__name__)

# ---- Pydantic models ----


class FontEntry(BaseModel):
    family: str = Field(..., min_length=1, description="CSS font-family name")
    url: str = Field("", description="Original woff2 URL")
    data_base64: str = Field(..., min_length=1, description="Base64-encoded woff2 bytes")


class DecodeRequest(BaseModel):
    html: str = Field(..., min_length=1, max_length=10_000_000, description="Page HTML including inline styles")
    fonts: list[FontEntry] = Field(..., min_length=1, description="Obfuscated font files used on the page")
    session_id: str = Field("", description="Session identifier for caching")


class DecodeStats(BaseModel):
    total_chars: int = 0
    exact: int = 0
    knn: int = 0
    cnn: int = 0
    unknown: int = 0
    accuracy_estimate: float = 0.0


class DecodeResponse(BaseModel):
    text: str = ""
    stats: DecodeStats = Field(default_factory=DecodeStats)


# ---- App lifecycle ----


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Initialize FAISSHashIndex, FontReverser, and PipelineOrchestrator at startup."""
    import sys
    from pathlib import Path

    # Ensure engine is importable
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

    from engine.faiss_index import FAISSHashIndex
    from engine.font_reverser import FontReverser
    from engine.glyph_classifier import GlyphClassifier
    from engine.pipeline import PipelineOrchestrator

    db_path = os.environ.get("DB_PATH", "data/reference/db/glyphs.db")
    index_path = os.environ.get("FAISS_INDEX", "data/reference/db/faiss_index.faiss")

    if not Path(db_path).exists():
        logger.warning("Database not found at %s — /decode will fail", db_path)
        app.state.faiss_index = None
        app.state.reverser = None
        app.state.classifier = None
        app.state.pipeline = None
        app.state.initialized = False
    else:
        app.state.faiss_index = FAISSHashIndex(db_path, index_path)
        app.state.reverser = FontReverser(app.state.faiss_index)

        # Load CNN classifier (Solution C) if model file is available
        classifier_model = os.environ.get("CLASSIFIER_MODEL", "")
        classifier_label_map = os.environ.get("CLASSIFIER_LABEL_MAP", "")
        app.state.classifier = None
        if classifier_model and Path(classifier_model).exists():
            try:
                if not classifier_label_map or not Path(classifier_label_map).exists():
                    logger.warning(
                        "CLASSIFIER_LABEL_MAP not found at '%s' — classifier disabled",
                        classifier_label_map,
                    )
                else:
                    with open(classifier_label_map, "r") as f:
                        label_to_char = {int(k): v for k, v in json.load(f).items()}
                    num_classes = len(label_to_char)
                    app.state.classifier = GlyphClassifier(
                        model_path=classifier_model,
                        num_classes=num_classes,
                        label_to_char=label_to_char,
                        confidence_threshold=0.95,
                    )
                    logger.info("CNN classifier loaded: %d classes", num_classes)
            except Exception as e:
                logger.warning("Failed to load classifier: %s", e)
        else:
            logger.info("No classifier model configured — Solution C disabled")

        app.state.pipeline = PipelineOrchestrator(
            app.state.reverser, classifier=app.state.classifier,
        )
        app.state.initialized = True
        logger.info("FDE engine initialized: %d vectors loaded", app.state.faiss_index.n_total)

    yield

    if app.state.faiss_index is not None:
        app.state.faiss_index.close()
        logger.info("FDE engine shut down")


app = FastAPI(
    title="FDE API",
    version="0.1.0",
    description="Font De-Obfuscation Engine — recovers Chinese text from obfuscated web fonts",
    lifespan=lifespan,
)
app.state.start_time = time.time()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ---- Endpoints ----


@app.get("/health")
async def health():
    """Service health check."""
    faiss = getattr(app.state, "faiss_index", None)
    initialized = getattr(app.state, "initialized", False)
    classifier = getattr(app.state, "classifier", None)
    return {
        "status": "ok" if initialized else "degraded",
        "uptime": round(time.time() - app.state.start_time, 1),
        "index_vectors": faiss.n_total if faiss else 0,
        "classifier": "loaded" if classifier else "disabled",
        "version": "0.1.0",
    }


@app.post("/api/v1/decode", response_model=DecodeResponse)
async def decode(request: DecodeRequest):
    """Decode a page with obfuscated fonts.

    Accepts full page HTML and a list of font files (base64-encoded woff2).
    Returns the decoded text with per-character mapping statistics.
    """
    pipeline = getattr(app.state, "pipeline", None)
    if pipeline is None:
        raise HTTPException(
            status_code=503,
            detail="FDE engine not initialized — check DB_PATH and FAISS_INDEX",
        )

    # Decode base64 font bytes
    font_map: dict[str, bytes] = {}
    for fe in request.fonts:
        try:
            font_bytes = base64.b64decode(fe.data_base64, validate=True)
        except (binascii.Error, ValueError) as e:
            logger.warning("Failed to decode base64 for font '%s': %s", fe.family, e)
            continue
        if fe.family in font_map:
            logger.warning("Duplicate font family '%s' — overwriting", fe.family)
        font_map[fe.family] = font_bytes

    if not font_map:
        raise HTTPException(status_code=400, detail="No valid font files provided")

    result = await pipeline.process(request.html, font_map)

    stats = DecodeStats(
        total_chars=result.stats.get("total_chars", 0),
        exact=result.stats.get("exact", 0),
        knn=result.stats.get("knn", 0),
        cnn=result.stats.get("cnn", 0),
        unknown=result.stats.get("unknown", 0),
        accuracy_estimate=result.stats.get("accuracy_estimate", 0.0),
    )

    return DecodeResponse(text=result.text, stats=stats)
