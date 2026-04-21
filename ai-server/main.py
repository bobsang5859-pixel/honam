"""
Hospital AI Server — 의뢰서 분석 API
FastAPI + Tesseract OCR + llama-cpp-python (오픈소스 LLM 내장)

실행: python main.py
또는: uvicorn main:app --host 0.0.0.0 --port 8000 --reload
"""
from fastapi import FastAPI, UploadFile, File, Form, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from services.ocr import extract_text
from services.parser import parse_referral_text
from services.llm import analyze_with_llm, is_llm_available

app = FastAPI(title="Hospital AI Server", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
async def health_check():
    """서버 상태 + LLM 로딩 상태 확인."""
    llm_ok = is_llm_available()
    return {
        "status": "ok",
        "llm_available": llm_ok,
        "mode": "llm" if llm_ok else "rule-based",
        "message": "오픈소스 LLM 활성 (llama-cpp-python)" if llm_ok else "규칙 기반 파서 모드 (LLM 미로딩)",
    }


@app.post("/analyze")
async def analyze_referral(
    file: UploadFile = File(...),
    memo: str = Form(""),
):
    """의뢰서 이미지를 분석하여 구조화된 환자 정보를 반환.

    1. Tesseract OCR로 텍스트 추출
    2. LLM이 로딩되어 있으면 LLM으로 구조화 (더 정확)
    3. LLM 없으면 규칙 기반 파서로 구조화 (fallback)
    """
    if not file.content_type or not (
        file.content_type.startswith("image/") or file.content_type == "application/pdf"
    ):
        raise HTTPException(400, "이미지 파일(JPG, PNG) 또는 PDF만 지원합니다.")

    image_bytes = await file.read()
    if len(image_bytes) > 10 * 1024 * 1024:
        raise HTTPException(400, "파일 크기는 10MB 이하만 가능합니다.")

    # 1. OCR
    ocr_result = extract_text(image_bytes)
    if ocr_result.get("error"):
        raise HTTPException(500, f"OCR 처리 실패: {ocr_result['error']}")

    ocr_text = ocr_result["text"]
    confidence = ocr_result["confidence"]

    if not ocr_text.strip():
        return {
            "success": False,
            "error": "이미지에서 텍스트를 인식하지 못했습니다.",
            "confidence": 0,
            "mode": "failed",
        }

    # 2. LLM 분석 시도
    llm_result = analyze_with_llm(ocr_text)
    if llm_result:
        llm_result["rawText"] = ocr_text
        llm_result["confidence"] = confidence
        return {"success": True, "mode": "llm", "data": llm_result}

    # 3. Fallback: 규칙 기반 파서
    parsed = parse_referral_text(ocr_text)
    parsed["confidence"] = confidence
    return {"success": True, "mode": "rule-based", "data": parsed}


@app.on_event("startup")
async def startup():
    """서버 시작 시 LLM 모델 미리 로딩 (백그라운드)."""
    import asyncio
    asyncio.get_event_loop().run_in_executor(None, is_llm_available)
    print("[AI Server] http://localhost:8000 에서 실행 중")
    print("[AI Server] LLM 모델 로딩은 백그라운드에서 진행됩니다...")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
