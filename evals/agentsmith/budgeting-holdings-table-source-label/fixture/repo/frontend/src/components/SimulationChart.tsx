"use client";

type Point = Record<string, number>;

type Line = {
  key: string;
  label: string;
  color: string;
  dashed?: boolean;
};

type Band = {
  lowerKey: string;
  upperKey: string;
  label: string;
  color: string;
};

type Props = {
  ariaLabel: string;
  data: Point[];
  lines: Line[];
  band?: Band;
  xKey?: string;
  formatValue?: (value: number) => string;
};

const WIDTH = 800;
const HEIGHT = 300;
const PAD_X = 56;
const PAD_Y = 24;

export default function SimulationChart({
  ariaLabel,
  data,
  lines,
  band,
  xKey = "year",
  formatValue = (value) => `$${Math.round(value).toLocaleString()}`,
}: Props) {
  if (!data.length) return null;
  const keys = [...lines.map((line) => line.key), ...(band ? [band.lowerKey, band.upperKey] : [])];
  const yValues = data.flatMap((point) => keys.map((key) => point[key]));
  const minY = Math.min(0, ...yValues);
  const maxY = Math.max(1, ...yValues);
  const minX = Math.min(...data.map((point) => point[xKey]));
  const maxX = Math.max(minX + 1, ...data.map((point) => point[xKey]));
  const x = (value: number) => PAD_X + ((value - minX) / (maxX - minX)) * (WIDTH - PAD_X * 2);
  const y = (value: number) =>
    HEIGHT - PAD_Y - ((value - minY) / (maxY - minY)) * (HEIGHT - PAD_Y * 2);
  const points = (key: string, rows = data) =>
    rows.map((point) => `${x(point[xKey])},${y(point[key])}`).join(" ");
  const bandPoints = band
    ? `${points(band.upperKey)} ${points(band.lowerKey, [...data].reverse())}`
    : "";
  const ticks = [0, 0.5, 1].map((fraction) => minY + (maxY - minY) * fraction);

  return (
    <figure className="min-w-0" aria-label={ariaLabel}>
      <svg
        role="img"
        aria-label={ariaLabel}
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        className="h-auto w-full min-w-[560px]"
      >
        {ticks.map((value) => (
          <g key={value}>
            <line
              x1={PAD_X}
              x2={WIDTH - PAD_X}
              y1={y(value)}
              y2={y(value)}
              stroke="#e4e4e7"
              strokeWidth="1"
            />
            <text x="4" y={y(value) + 4} className="fill-zinc-500 text-[10px]">
              {formatValue(value)}
            </text>
          </g>
        ))}
        {band && <polygon points={bandPoints} fill={band.color} opacity="0.14" />}
        {lines.map((line) => (
          <polyline
            key={line.key}
            points={points(line.key)}
            fill="none"
            stroke={line.color}
            strokeWidth="3"
            strokeDasharray={line.dashed ? "8 6" : undefined}
          />
        ))}
        <text x={PAD_X} y={HEIGHT - 3} className="fill-zinc-500 text-[10px]">
          Year {minX.toFixed(0)}
        </text>
        <text
          x={WIDTH - PAD_X}
          y={HEIGHT - 3}
          textAnchor="end"
          className="fill-zinc-500 text-[10px]"
        >
          Year {maxX.toFixed(0)}
        </text>
      </svg>
      <figcaption className="mt-2 flex flex-wrap gap-4 text-xs text-zinc-600">
        {band && (
          <span className="flex items-center gap-1">
            <span className="h-2.5 w-4 rounded-sm" style={{ backgroundColor: band.color }} />
            {band.label}
          </span>
        )}
        {lines.map((line) => (
          <span key={line.key} className="flex items-center gap-1">
            <span className="h-0.5 w-4" style={{ backgroundColor: line.color }} />
            {line.label}
          </span>
        ))}
      </figcaption>
    </figure>
  );
}
