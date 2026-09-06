/**
 * The GitLab tanuki, as an inline SVG.
 *
 * Inline rather than a file, because a status bar tile is built in JS and a
 * background-image would need a second round trip and a fixed colour.
 *
 * This is the single-path silhouette from GitLab's own logo-square.svg. The
 * full mark is eight overlapping paths in four brand colours; at the 12px a
 * status bar gives you they overlap into mud, so the outline is drawn once in
 * the brand orange instead. Kept as one path for that reason - it is not a
 * partial copy that wants finishing.
 */

const SVG_NS = 'http://www.w3.org/2000/svg';

const TANUKI = 'M491.999988,194.666662 L464.441322,279.481326 L409.82399,447.578655 ' +
  'C407.014656,456.226655 394.778657,456.226655 391.96799,447.578655 L337.349325,279.481326 ' +
  'L155.982663,279.481326 L101.362664,447.578655 C98.5533309,456.226655 86.3173312,456.226655 ' +
  '83.5066646,447.578655 L28.8893326,279.481326 L1.33199997,194.666662 ' +
  'C-1.18266664,186.930662 1.57199996,178.455996 8.1519998,173.674662 ' +
  'L246.665327,0.385333324 L485.179988,173.674662 C491.759988,178.455996 494.513321,186.930662 ' +
  '491.999988,194.666662';

/**
 * @returns {SVGElement} a fresh logo element - one per tile, never shared,
 *   because a DOM node can only be in one place at a time.
 */
function gitlabLogo () {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 500 500');
  svg.setAttribute('class', 'gl-logo');
  // Decorative: the tile's own title says what this is, so a screen reader
  // announcing "image" here would only add noise.
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');

  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', TANUKI);
  svg.appendChild(path);
  return svg;
}

module.exports = { gitlabLogo, TANUKI };
