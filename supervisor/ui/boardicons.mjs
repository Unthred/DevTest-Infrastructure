// Issue #1317: the agent icons of the live board. Each icon is requested once per agent each time the screen opens (a new store per open);
// no timer, and a model change asks for no icon it has already asked for. The file is read into a data address so the page needs no image
// source beyond data: (see the security headers of the dashboard), and it is tried as an image first: an icon that does not load is a failure.
import { iconPathOk } from './boardball.mjs';

const toDataAddress = bytes => {
  let binary = '';
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
  return `data:image/svg+xml;base64,${btoa(binary)}`;
};

const probeImage = address => new Promise(resolve => {
  const image = new Image();
  image.onload = () => resolve(true);
  image.onerror = () => resolve(false);
  image.src = address;
});

export class IconStore {
  // onChange is called when an icon has loaded, so the board is drawn again with the shape; a failure changes nothing on screen.
  constructor(onChange, deps = {}) {
    this.onChange = onChange;
    this.fetchFn = deps.fetchFn ?? globalThis.fetch?.bind(globalThis);
    this.probe = deps.probe ?? probeImage;
    this.asked = new Set();
    this.loaded = new Map();
    this.closed = false;
  }

  request(agents) {
    for (const agent of agents) {
      if (this.closed || this.asked.has(agent.id) || !iconPathOk(agent.icon)) continue;
      this.asked.add(agent.id);
      this.load(agent);
    }
  }

  async load(agent) {
    try {
      const response = await this.fetchFn(agent.icon, { cache: 'no-store', headers: { accept: 'image/svg+xml' } });
      if (!response.ok || !String(response.headers.get('content-type') ?? '').startsWith('image/svg+xml')) return;
      const address = toDataAddress(await response.arrayBuffer());
      if (!(await this.probe(address)) || this.closed) return;
      this.loaded.set(agent.id, address);
      this.onChange();
    } catch {
      // Any failure leaves the agent with its disc and letter.
    }
  }

  href(id) {
    return this.loaded.get(id) ?? null;
  }

  close() {
    this.closed = true;
  }
}
