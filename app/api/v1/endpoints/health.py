from fastapi import APIRouter
from pydantic import BaseModel
import time

router = APIRouter()

class HealthResponse(BaseModel):
    status: str
    timestamp: float

class DetailedHealthResponse(BaseModel):
    status: str
    api: str
    database: str
    model: str
    timestamp: float

@router.get("", response_model=HealthResponse)
def check_health():
    return {"status": "ok", "timestamp": time.time()}

@router.get("/detailed", response_model=DetailedHealthResponse)
def check_detailed_health():
    return {
        "status": "ok",
        "api": "ok",
        "database": "unconfigured",
        "model": "unconfigured",
        "timestamp": time.time()
    }
