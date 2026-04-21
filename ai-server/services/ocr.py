"""
Tesseract OCR 서비스 — 의뢰서 이미지에서 텍스트 추출
"""
import pytesseract
from PIL import Image
import io
import platform

# Windows Tesseract 경로 (설치 필요: https://github.com/UB-Mannheim/tesseract/wiki)
if platform.system() == "Windows":
    pytesseract.pytesseract.tesseract_cmd = r"C:\Program Files\Tesseract-OCR\tesseract.exe"


def extract_text(image_bytes: bytes) -> dict:
    """이미지 바이트에서 텍스트를 추출한다."""
    try:
        image = Image.open(io.BytesIO(image_bytes))

        # 이미지 전처리 (OCR 정확도 향상)
        image = image.convert("L")  # 그레이스케일

        # 한국어 + 영어 OCR (kor+eng 언어팩 필요)
        result = pytesseract.image_to_data(
            image, lang="kor+eng", output_type=pytesseract.Output.DICT
        )

        # 전체 텍스트 조합
        full_text = pytesseract.image_to_string(image, lang="kor+eng")

        # 평균 신뢰도 계산
        confidences = [
            int(c) for c in result["conf"] if str(c).strip() != "-1"
        ]
        avg_confidence = (
            sum(confidences) / len(confidences) if confidences else 0
        )

        return {
            "text": full_text.strip(),
            "confidence": round(avg_confidence, 1),
            "word_count": len([w for w in result["text"] if w.strip()]),
        }
    except Exception as e:
        return {"text": "", "confidence": 0, "word_count": 0, "error": str(e)}
