<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## 문제 해결소 제품 컨텍스트

이 저장소를 수정하기 전에 반드시 루트의 `PROJECT_CONTEXT.md`를 읽고 그 제품 운영 계약을 우선합니다.
특히 WordPress는 현재 선택 사항이며, 일일 GitHub Actions → Firestore → Notion → ChatGPT Plus 수동 검증 흐름을 깨뜨리지 않습니다.

## 저장소 패치 방식

사용자 전달용 코드 수정은 `PROJECT_CONTEXT.md`의 `개발/패치 적용 규칙`을 따른다. 별도 브랜치/PR을 기본 흐름으로 만들지 않는다.

