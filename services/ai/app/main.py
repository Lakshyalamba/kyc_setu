from fastapi import FastAPI

from app.routers import extract, health, match

app = FastAPI(title="KYC Setu AI (stub)", version="0.0.0")
app.include_router(health.router)
app.include_router(extract.router)
app.include_router(match.router)
