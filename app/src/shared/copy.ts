/** 모델 선택 차단: main의 전송 오류와 renderer의 안내가 같은 문구를 쓴다. */
export const MODEL_SELECTION_COPY = {
  reselectionTitle: '모델 다시 선택 필요',
  reselectionRequired: '저장된 모델은 다른 AI 회사로 연결돼 사용할 수 없어요. 모델 칩에서 ChatGPT 모델이나 계정 기본을 직접 고른 뒤 다시 보내 주세요.',
  crossProviderDefault: '계정 기본 모델이 다른 AI 회사로 연결돼 전송하지 않았어요. 모델 칩에서 ChatGPT 모델을 직접 골라 주세요.'
}

/** 실제 Claude 인증 실패 뒤 대화·연결 상태에 공통으로 쓰는 복구 안내. */
export const CLAUDE_AUTH_COPY = {
  required: 'Claude 로그인이 만료됐거나 인증을 확인하지 못했어요. 아래 AI 이름을 눌러 Claude로 다시 로그인한 뒤 보내 주세요.'
}

/** 인계 복구가 끝나지 않은 상태에서는 로그인 실패 대신 복구 경로를 안내한다. */
export const UPDATE_RECOVERY_COPY = '업데이트를 마치지 못했을 수 있어요. 위쪽 업데이트를 눌러 상태를 확인하고 다시 시도해 주세요.'
