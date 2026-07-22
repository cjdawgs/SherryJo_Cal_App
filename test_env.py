import os
from dotenv import load_dotenv

# Force load the .env file
load_dotenv()

# Print out a couple of your keys to verify (Replace these names with keys actually inside your .env)
print("SECRET_KEY loaded:", os.getenv("SECRET_KEY") is not None)
print("DATABASE_URL loaded:", os.getenv("DATABASE_URL") is not None)