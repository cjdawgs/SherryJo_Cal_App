from sqlalchemy import Column, String

# ✅ add these columns
external_id = Column(String, unique=True, index=True)
source = Column(String, default="local")# Auto-generated: event_model.py
