
import os
from dotenv import load_dotenv
from google import genai

load_dotenv()

api_key = os.getenv("GEMINI_API_KEY")
model = os.getenv("GEMINI_MODEL", "gemini-3.5-flash")

if not api_key:
    print("ERROR: Gemini API key not found in .env")
    exit()

try:
    client = genai.Client(api_key=api_key)

    print("Testing Gemini connection...")
    print("Model:", model)

    response = client.models.generate_content(
        model=model,
        contents="Hello Gemini! Reply with a short greeting."
    )

    print("\nSUCCESS! Gemini is working.")
    print("Response:", response.text)

except Exception as e:
    print("\nGEMINI ERROR:")
    print(type(e).__name__)
    print(str(e))
