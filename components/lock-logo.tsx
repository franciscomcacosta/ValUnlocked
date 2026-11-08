// Val Unlocked lock-mark — Valorant red tile with a dark lock whose right arm
// snaps open on a loop. Used in headers and the login card.

type Props = {
  size?: number;        // outer tile edge, in px
  tileBg?: string;      // override the red tile
  lockColor?: string;   // override the dark lock stroke
};

export function LockLogo({
  size = 44,
  tileBg = "var(--vu-red)",
  lockColor = "var(--vu-navy)",
}: Props) {
  const inner = Math.round(size * 0.64);
  return (
    <span
      className="cs"
      aria-hidden="true"
      style={{
        width: size,
        height: size,
        background: tileBg,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        flex: "none",
      }}
    >
      <svg
        className="lk"
        viewBox="0 0 24 24"
        width={inner}
        height={inner}
        fill="none"
        aria-hidden="true"
      >
        <rect x="5" y="11" width="14" height="9.5" rx="2" fill={lockColor} />
        <circle cx="12" cy="15" r="1.4" fill="var(--vu-red)" />
        <rect
          x="11.35"
          y="15.4"
          width="1.3"
          height="3"
          rx="0.4"
          fill="var(--vu-red)"
        />
        <path
          d="M8 11 V7 a4 4 0 0 1 4-4"
          stroke={lockColor}
          strokeWidth="2"
          strokeLinecap="round"
        />
        <path
          className="arm-r"
          d="M16 11 V7 a4 4 0 0 0 -4-4"
          stroke={lockColor}
          strokeWidth="2"
          strokeLinecap="round"
        />
      </svg>
    </span>
  );
}
