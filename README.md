# MUEdit

브라우저에서 바로 쓰는 클립 기반 음악 편집기입니다. 업로드한 오디오를 잘라서 조각 단위로 이동하고, 각 조각마다 볼륨과 페이드 인/아웃을 따로 걸고, 무음 구간까지 넣은 뒤 최종 결과를 무손실 WAV로 내보낼 수 있습니다.

## 핵심 기능

- `audio/*` 파일 불러오기
- 빈 무음 구간 추가
- 클립 드래그 이동
- 양쪽 핸들로 트림
- 플레이헤드 위치에서 컷
- 클립별 볼륨 조절
- 클립별 페이드 인/아웃
- 줌 조절과 스냅 토글
- 소스 재배치
- 32-bit float WAV 내보내기

## 단축키

- `Space`: 재생 / 정지
- `S`: 현재 플레이헤드 위치에서 컷
- `Delete`: 선택한 클립 삭제
- `ArrowLeft / ArrowRight`: 플레이헤드 미세 이동
- `Shift + ArrowLeft / ArrowRight`: 플레이헤드 크게 이동

## 실행

```bash
npm install
npm run dev
```

브라우저에서 [http://localhost:3000](http://localhost:3000) 을 열면 됩니다.

## 빌드

```bash
npm run lint
npm run build
```

## 배포

Next.js App Router 기반이라 Vercel 배포에 바로 맞습니다.

```bash
vercel
```

권장 사항:

- 최신 Chromium 계열 브라우저에서 테스트
- 큰 파일 위주라면 데스크톱 환경 사용
- 최종 배포 전 실제 샘플 음원으로 export 결과 확인
