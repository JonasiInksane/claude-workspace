// A sparkline (mockup .spark): an SVG polyline scaled to its own minimum and maximum, drawn
// with SVG attributes only (no style). It is an image to screen readers, so `label` must say
// what the line shows in words ("Health score, last 10 scans: 64 to 72").
const NS = 'http://www.w3.org/2000/svg';

// spark([64, 65, 72], 'Health score, last 3 scans: 64 to 72'). Values that are not numbers
// are left out; one value draws a flat line, none draws an empty frame.
export function spark(values, label) {
  const data = (Array.isArray(values) ? values : []).map(Number).filter(Number.isFinite);
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 100 28');
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.setAttribute('class', 'spark');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', String(label || (data.length ? `${data[0]} to ${data[data.length - 1]}` : 'No data yet')));
  if (!data.length) return svg;
  const points = data.length === 1 ? [data[0], data[0]] : data;
  const min = Math.min(...points);
  const span = Math.max(...points) - min || 1;
  const line = document.createElementNS(NS, 'polyline');
  line.setAttribute('points', points.map((v, i) =>
    `${(i / (points.length - 1) * 100).toFixed(1)},${(25 - (v - min) / span * 22).toFixed(1)}`).join(' '));
  svg.append(line);
  return svg;
}
