export function translationStatusView(availability) {
  if (availability === "available") return null;
  if (availability === "reconnecting") {
    return {
      healthLabel: "통역 재연결 중",
      message: "통역 재연결 중입니다. 잠시 원음을 정상 크기로 들려드립니다.",
    };
  }
  if (availability === "unavailable") {
    return {
      healthLabel: "통역 복구 대기 중",
      message: "통역을 복구하고 있습니다. 원음을 정상 크기로 계속 들려드립니다.",
    };
  }
  throw new Error(`unsupported translation availability: ${availability}`);
}
