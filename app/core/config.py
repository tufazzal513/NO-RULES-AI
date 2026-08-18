from pydantic_settings import BaseSettings, SettingsConfigDict
from typing import Optional, List

class Settings(BaseSettings):
    APP_NAME: str = "MY-AI"
    ENVIRONMENT: str = "production"
    API_V1_STR: str = "/api/v1"
    PUBLIC_BASE_URL: Optional[str] = None
    
    DATABASE_URL: str = "sqlite:///./my_ai.db"
    
    TELEGRAM_BOT_TOKEN: Optional[str] = None
    TELEGRAM_STORAGE_CHAT_ID: Optional[str] = None
    
    API_SECRET: Optional[str] = None
    ENCRYPTION_KEY: Optional[str] = None
    
    ALLOWED_ORIGINS: str = "*" # Comma-separated in env
    ADMIN_EMAIL: Optional[str] = None
    
    MODEL_PATH: Optional[str] = None
    ACTIVE_MODEL: str = "BasicEngine"
    
    BACKUP_ENABLED: bool = True
    RESEARCH_ENABLED: bool = True
    MEMORY_ENABLED: bool = True
    RAG_ENABLED: bool = True

    model_config = SettingsConfigDict(env_file=".env", env_ignore_empty=True, extra="ignore")

settings = Settings()
