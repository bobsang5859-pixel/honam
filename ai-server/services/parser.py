"""
의뢰서 텍스트 파싱 — 규칙 기반 + 키워드 매칭으로 환자 정보 추출
Ollama LLM 사용 가능 시 LLM 기반 구조화로 자동 전환
"""
import re
from typing import Optional


def parse_referral_text(text: str) -> dict:
    """OCR 텍스트에서 환자 정보를 추출한다."""
    result = {
        "patientName": "",
        "diagnosis": "",
        "mainDiseaseCode": "",
        "insuranceType": "",
        "condition": "",
        "gender": "",
        "age": "",
        "prevHospital": "",
        "medications": [],
        "aiSummary": "",
        "admissionPossible": True,
        "rawText": text,
    }

    if not text:
        return result

    lines = text.split("\n")

    # 환자명 추출
    result["patientName"] = _extract_field(
        text, lines,
        [r"환자\s*(?:성)?명\s*[:：\s]\s*(.+)",
         r"성\s*명\s*[:：\s]\s*(.+)",
         r"이\s*름\s*[:：\s]\s*(.+)"]
    )

    # 진단명 추출
    result["diagnosis"] = _extract_field(
        text, lines,
        [r"진단명\s*[:：\s]\s*(.+)",
         r"(?:주)?상병명\s*[:：\s]\s*(.+)",
         r"병\s*명\s*[:：\s]\s*(.+)",
         r"최종\s*진단\s*[:：\s]\s*(.+)"]
    )

    # 주상병코드 (ICD-10 패턴: 알파벳 + 2~3자리 숫자 + 선택적 소수점)
    icd_match = re.search(r"[A-Z]\d{2,3}(?:\.\d{1,2})?", text)
    if icd_match:
        result["mainDiseaseCode"] = icd_match.group()

    # 보험유형
    result["insuranceType"] = _extract_insurance(text)

    # 상태/현병력
    result["condition"] = _extract_field(
        text, lines,
        [r"(?:현\s*)?병\s*력\s*[:：\s]\s*(.+)",
         r"환자\s*상태\s*[:：\s]\s*(.+)",
         r"주\s*(?:호)?소\s*[:：\s]\s*(.+)"]
    )

    # 성별
    if re.search(r"[남M]", text[:200]):
        result["gender"] = "남"
    elif re.search(r"[여F]", text[:200]):
        result["gender"] = "여"

    # 나이
    age_match = re.search(r"(?:나이|연령|age)\s*[:：\s]*(\d{1,3})\s*(?:세|歲)?", text, re.I)
    if age_match:
        result["age"] = age_match.group(1)

    # 생년월일에서 나이 계산
    if not result["age"]:
        birth_match = re.search(r"(?:생년월일|생년)\s*[:：\s]*(\d{4})[-./]?(\d{2})", text)
        if birth_match:
            from datetime import datetime
            birth_year = int(birth_match.group(1))
            result["age"] = str(datetime.now().year - birth_year)

    # 의뢰기관/전원병원
    result["prevHospital"] = _extract_field(
        text, lines,
        [r"의뢰\s*(?:기관|병원)\s*[:：\s]\s*(.+)",
         r"전원\s*(?:기관|병원)\s*[:：\s]\s*(.+)",
         r"(?:현재|소속)\s*병원\s*[:：\s]\s*(.+)"]
    )

    # 약물 추출 (일반적인 약물명 패턴)
    result["medications"] = _extract_medications(text)

    # AI 요약 생성 (규칙 기반)
    result["aiSummary"] = _generate_summary(result)

    return result


def _extract_field(text: str, lines: list, patterns: list) -> str:
    """여러 패턴을 시도하여 첫 번째 매칭 결과를 반환."""
    for pattern in patterns:
        match = re.search(pattern, text, re.M)
        if match:
            value = match.group(1).strip()
            # 줄바꿈 이전까지만
            value = value.split("\n")[0].strip()
            # 뒤따르는 키워드 제거
            value = re.split(r"\s{2,}|\t", value)[0].strip()
            if len(value) > 1:
                return value
    return ""


def _extract_insurance(text: str) -> str:
    """보험유형을 키워드로 매칭."""
    patterns = [
        (r"의료급여\s*1\s*종|의료\s*1\s*종", "의료급여 1종"),
        (r"의료급여\s*2\s*종|의료\s*2\s*종", "의료급여 2종"),
        (r"의료급여", "의료급여 1종"),
        (r"산재\s*보험|산업재해", "산재보험"),
        (r"자동차\s*보험|자보", "자동차보험"),
        (r"건강\s*보험|직장\s*가입|지역\s*가입", "건강보험"),
    ]
    for pattern, label in patterns:
        if re.search(pattern, text):
            return label
    return "건강보험"


def _extract_medications(text: str) -> list:
    """약물명을 추출한다."""
    meds = []
    # 일반적인 약물명 패턴 (영문 + 숫자mg/ml)
    med_pattern = r"([A-Za-z][A-Za-z\s\-]{2,30})\s*(\d+\.?\d*\s*(?:mg|ml|g|mcg|tab|cap))"
    for match in re.finditer(med_pattern, text, re.I):
        med = f"{match.group(1).strip()} {match.group(2).strip()}"
        if med not in meds:
            meds.append(med)
    return meds[:20]  # 최대 20개


def _generate_summary(parsed: dict) -> str:
    """파싱 결과로 간단한 요약문을 생성한다."""
    parts = []
    if parsed["age"] and parsed["gender"]:
        parts.append(f"{parsed['age']}세 {parsed['gender']}성")
    if parsed["diagnosis"]:
        parts.append(f"진단: {parsed['diagnosis']}")
    if parsed["mainDiseaseCode"]:
        parts.append(f"({parsed['mainDiseaseCode']})")
    if parsed["condition"]:
        parts.append(f"상태: {parsed['condition'][:50]}")
    if parsed["prevHospital"]:
        parts.append(f"{parsed['prevHospital']}에서 전원")
    if parsed["medications"]:
        parts.append(f"투약 {len(parsed['medications'])}종")

    if not parts:
        return "의뢰서 내용을 충분히 인식하지 못했습니다. 담당자 확인이 필요합니다."

    return ", ".join(parts) + ". 입원 검토 필요."
