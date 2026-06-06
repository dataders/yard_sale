import base64
import json
import re
from pathlib import Path

import anthropic
from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

app = FastAPI(title="Yard Sale Image Matcher")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

client = anthropic.Anthropic()
REPO_ROOT = Path(__file__).parent.parent
SALES_FILE = REPO_ROOT / "data" / "sales.json"

ALLOWED_TYPES = {"image/jpeg", "image/png", "image/gif", "image/webp"}

_sales_cache: list[dict] | None = None


def load_sales() -> list[dict]:
    global _sales_cache
    if _sales_cache is None:
        data = json.loads(SALES_FILE.read_text())
        _sales_cache = data["sales"]
    return _sales_cache


def match_sales(keywords: list[str], sales: list[dict]) -> list[dict]:
    scored: list[tuple[int, dict]] = []
    kw_lower = [k.lower() for k in keywords]
    for sale in sales:
        if not sale.get("items"):
            continue
        items_lower = sale["items"].lower()
        hits = sum(1 for k in kw_lower if k in items_lower)
        if hits:
            scored.append((hits, sale))
    scored.sort(key=lambda x: x[0], reverse=True)
    return [s for _, s in scored[:10]]


def ebay_url(query: str) -> str:
    from urllib.parse import quote_plus
    return f"https://www.ebay.com/sch/i.html?_nkw={quote_plus(query)}"


def fb_url(query: str) -> str:
    from urllib.parse import quote_plus
    return f"https://www.facebook.com/marketplace/search/?query={quote_plus(query)}"


@app.post("/api/analyze")
async def analyze_image(file: UploadFile = File(...)):
    if file.content_type not in ALLOWED_TYPES:
        raise HTTPException(400, f"Unsupported file type: {file.content_type}")

    image_bytes = await file.read()
    if len(image_bytes) > 20 * 1024 * 1024:
        raise HTTPException(400, "Image too large (max 20 MB)")

    b64 = base64.standard_b64encode(image_bytes).decode()

    response = client.messages.create(
        model="claude-opus-4-8",
        max_tokens=1024,
        thinking={"type": "adaptive"},
        messages=[
            {
                "role": "user",
                "content": [
                    {
                        "type": "image",
                        "source": {
                            "type": "base64",
                            "media_type": file.content_type,
                            "data": b64,
                        },
                    },
                    {
                        "type": "text",
                        "text": (
                            "Identify what is in this image. Respond with:\n"
                            "1. A short description (1-2 sentences).\n"
                            "2. A JSON object on the last line with:\n"
                            '   {"item": "<primary item name>", '
                            '"keywords": ["<keyword1>", "<keyword2>", ...], '
                            '"search_query": "<best eBay/marketplace search query>"}\n'
                            "Keywords should be 3-8 specific terms useful for searching "
                            "yard sale listings (e.g. brand, category, material, style)."
                        ),
                    },
                ],
            }
        ],
    )

    text = ""
    for block in response.content:
        if block.type == "text":
            text = block.text
            break

    # Extract JSON from last line or anywhere in response
    json_match = re.search(r'\{[^{}]*"item"[^{}]*"keywords"[^{}]*\}', text, re.DOTALL)
    if not json_match:
        raise HTTPException(500, "Could not parse Claude response")

    parsed = json.loads(json_match.group())
    item_name: str = parsed.get("item", "item")
    keywords: list[str] = parsed.get("keywords", [item_name])
    search_query: str = parsed.get("search_query", item_name)

    description_lines = text[: json_match.start()].strip().split("\n")
    description = " ".join(l.strip().lstrip("1.").strip() for l in description_lines if l.strip())

    sales = load_sales()
    matches = match_sales(keywords, sales)

    return {
        "item": item_name,
        "description": description,
        "keywords": keywords,
        "matches": matches,
        "external": {
            "ebay": ebay_url(search_query),
            "facebook": fb_url(search_query),
        },
    }


# Serve static site at root — must come after API routes
app.mount("/", StaticFiles(directory=str(REPO_ROOT), html=True), name="static")
