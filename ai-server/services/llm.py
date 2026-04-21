"""
LLM 서비스 — llama-cpp-python으로 오픈소스 LLM 직접 실행
별도 프로그램 설치 없이 Python 코드만으로 AI 실행

모델 파일은 최초 실행 시 자동 다운로드됨 (약 2~4GB)
"""
import json
import re
import os
from typing import Optional

_llm_instance = None
_model_path = None

MODEL_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), "models")
# HuggingFace에서 다운로드할 경량 모델 (한국어 지원, 4bit 양자화)
MODEL_REPO = "bartowski/Llama-3.2-3B-Instruct-GGUF"
MODEL_FILE = "Llama-3.2-3B-Instruct-Q4_K_M.gguf"


def _get_model_path() -> str:
    """모델 파일 경로를 반환. 없으면 자동 다운로드."""
    global _model_path
    if _model_path and os.path.exists(_model_path):
        return _model_path

    local_path = os.path.join(MODEL_DIR, MODEL_FILE)
    if os.path.exists(local_path):
        _model_path = local_path
        return local_path

    # 자동 다운로드
    print(f"[LLM] 모델 다운로드 중... ({MODEL_REPO}/{MODEL_FILE})")
    print("[LLM] 최초 1회만 다운로드됩니다. 약 2GB, 몇 분 소요될 수 있습니다.")
    try:
        from huggingface_hub import hf_hub_download
        os.makedirs(MODEL_DIR, exist_ok=True)
        downloaded = hf_hub_download(
            repo_id=MODEL_REPO,
            filename=MODEL_FILE,
            local_dir=MODEL_DIR,
        )
        _model_path = downloaded
        print(f"[LLM] 모델 다운로드 완료: {downloaded}")
        return downloaded
    except Exception as e:
        print(f"[LLM] 모델 다운로드 실패: {e}")
        raise


def _get_llm():
    """LLM 인스턴스를 반환 (싱글톤)."""
    global _llm_instance
    if _llm_instance is not None:
        return _llm_instance

    try:
        from llama_cpp import Llama
        model_path = _get_model_path()
        print(f"[LLM] 모델 로딩 중... ({model_path})")
        _llm_instance = Llama(
            model_path=model_path,
            n_ctx=2048,       # 컨텍스트 길이
            n_threads=4,      # CPU 스레드
            n_gpu_layers=0,   # GPU 없으면 0, 있으면 -1 (전체 GPU)
            verbose=False,
        )
        print("[LLM] 모델 로딩 완료")
        return _llm_instance
    except Exception as e:
        print(f"[LLM] 모델 로딩 실패: {e}")
        return None


def is_llm_available() -> bool:
    """LLM 사용 가능 여부 확인."""
    try:
        return _get_llm() is not None
    except Exception:
        return False


def analyze_with_llm(ocr_text: str) -> Optional[dict]:
    """LLM으로 의뢰서 텍스트를 분석하여 구조화된 데이터를 반환."""
    llm = _get_llm()
    if llm is None:
        return None

    prompt = f"""다음은 병원 의뢰서를 OCR로 읽은 텍스트입니다. 아래 항목을 JSON으로 추출해주세요.
추출할 수 없는 항목은 빈 문자열("")로 남겨주세요.

OCR 텍스트:
---
{ocr_text[:2000]}
---

반드시 아래 JSON 형식으로만 응답하세요:
{{"patientName":"환자명","diagnosis":"진단명","mainDiseaseCode":"ICD-10코드","insuranceType":"건강보험/의료급여 1종/의료급여 2종/산재보험/자동차보험","condition":"상태요약","gender":"남/여","age":"나이","prevHospital":"의뢰기관명","medications":["약물1","약물2"],"aiSummary":"요약문","admissionPossible":true}}"""

    try:
        output = llm(
            prompt,
            max_tokens=512,
            temperature=0.1,
            stop=["```", "\n\n\n"],
        )
        response_text = output["choices"][0]["text"].strip()

        # JSON 추출
        json_str = _extract_json(response_text)
        if json_str:
            parsed = json.loads(json_str)
            defaults = {
                "patientName": "", "diagnosis": "", "mainDiseaseCode": "",
                "insuranceType": "건강보험", "condition": "", "gender": "",
                "age": "", "prevHospital": "", "medications": [],
                "aiSummary": "", "admissionPossible": True,
            }
            for k, v in defaults.items():
                if k not in parsed:
                    parsed[k] = v
            return parsed

    except Exception as e:
        print(f"[LLM] 분석 오류: {e}")

    return None


def _extract_json(text: str) -> Optional[str]:
    """텍스트에서 JSON 블록을 추출."""
    match = re.search(r"```(?:json)?\s*(\{[\s\S]*?\})\s*```", text)
    if match:
        return match.group(1)
    match = re.search(r"\{[\s\S]*\}", text)
    if match:
        return match.group()
    return None
