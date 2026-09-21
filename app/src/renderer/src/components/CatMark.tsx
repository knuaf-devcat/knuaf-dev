import { useId } from 'react'

/**
 * 앱 마크 — `build/icon-small.svg` 와 같은 도형이다(번들 아이콘의 32px 이하 버전).
 *
 * 사진 아이콘을 그대로 쓰지 않는 이유는 둘이다. 작은 크기에서 뭉개지고, 한 덩어리라
 * 부위별로 움직일 수 없다. 여기서는 같은 고양이를 도형 다섯으로 들고 있으므로
 * `animated` 를 켜면 귀·머리·선글라스가 따로 들어온다.
 *
 * 그라디언트 id 는 인스턴스마다 달라야 한다 — 사이드바와 여는 화면에 동시에 떠도
 * 서로의 정의를 덮지 않게.
 *
 * `label` 이 없으면 장식으로 친다. 옆에 같은 뜻의 글자가 붙어 있는 자리(사이드바)에서
 * 이름까지 달면 화면 낭독기가 같은 말을 두 번 읽는다.
 */
export function CatMark({ size = 24, animated = false, label }: { size?: number; animated?: boolean; label?: string }): React.JSX.Element {
  const uid = useId().replace(/:/g, '')
  return (
    <svg
      className={animated ? 'cat cat-anim' : 'cat'}
      viewBox="0 0 1024 1024" width={size} height={size}
      {...(label ? { role: 'img', 'aria-label': label } : { 'aria-hidden': true })}
    >
      <defs>
        <linearGradient id={`${uid}bg`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#31703d" /><stop offset="1" stopColor="#24532d" />
        </linearGradient>
        <clipPath id={`${uid}gl`}><rect x="288" y="448" width="448" height="144" rx="64" /></clipPath>
      </defs>
      <rect className="cat-bg" x="100" y="100" width="824" height="824" rx="229" ry="229" fill={`url(#${uid}bg)`} />
      <g className="cat-face">
        <path className="cat-ear l" d="M256 384 L288 192 L448 320 Z" fill="#fbf8f0" />
        <path className="cat-ear r" d="M768 384 L736 192 L576 320 Z" fill="#fbf8f0" />
        <rect className="cat-head" x="256" y="288" width="512" height="480" rx="176" fill="#fbf8f0" />
        <g className="cat-glass">
          <rect x="288" y="448" width="448" height="144" rx="64" fill="#17171a" />
          {animated && (
            <g clipPath={`url(#${uid}gl)`}>
              <rect className="cat-shine" x="240" y="428" width="120" height="184" fill="#ffffff" opacity=".85" />
            </g>
          )}
        </g>
      </g>
    </svg>
  )
}
