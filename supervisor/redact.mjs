// Anything shown on the page or handed to a job that originates from an error message or free text passes through this.
export function redact(value, max = 200) {
  return String(value ?? '')
    .replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, '[email]')
    .replace(/\b(?:gh[pousr]_|github_pat_|sk-|xox[abp]-)[\w-]{8,}/g, '[token]')
    .replace(/\b[Bb]earer\s+[\w.~+/=-]{8,}/g, 'Bearer [token]')
    .replace(/\b(?!0{40}\b)(?![0-9a-f]{40}\b)[A-Za-z0-9_-]{40,}\b/g, '[token]')
    .replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, max);
}
