import logging

def setup_logging():
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
    )
    logger = logging.getLogger("my-ai")
    logger.info("Logging configured for MY-AI")
    return logger

logger = setup_logging()
