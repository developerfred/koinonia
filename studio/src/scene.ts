export interface Layer {
  id: string;
  source: "camera" | "screen" | "text" | "image";
  x: number; y: number; w: number; h: number; // fractions of canvas, 0..1
  visible: boolean;
  opacity: number;
  text?: string;
}
export interface Scene { name: string; layers: Layer[] }
export interface SceneSnapshot { scene: string; layers: Layer[] }

export class SceneState {
  scenes = new Map<string, Scene>();
  current: string;
  private listeners: ((s: SceneSnapshot) => void)[] = [];

  constructor() {
    this.scenes.set("main", { name: "main", layers: [
      { id: "cam", source: "camera", x: 0, y: 0, w: 1, h: 1, visible: true, opacity: 1 },
      { id: "overlay", source: "text", x: 0.03, y: 0.85, w: 0.5, h: 0.1, visible: false, opacity: 1, text: "" },
    ] });
    this.scenes.set("screen", { name: "screen", layers: [
      { id: "scr", source: "screen", x: 0, y: 0, w: 1, h: 1, visible: true, opacity: 1 },
      { id: "cam", source: "camera", x: 0.74, y: 0.7, w: 0.24, h: 0.27, visible: true, opacity: 1 },
      { id: "overlay", source: "text", x: 0.03, y: 0.85, w: 0.5, h: 0.1, visible: false, opacity: 1, text: "" },
    ] });
    this.current = "main";
  }
  onChange(fn: (s: SceneSnapshot) => void) { this.listeners.push(fn); }
  private emit() { const s = this.snapshot(); this.listeners.forEach((l) => l(s)); }
  snapshot(): SceneSnapshot { return { scene: this.current, layers: structuredClone(this.scenes.get(this.current)!.layers) }; }
  names(): string[] { return [...this.scenes.keys()]; }

  switchScene(name: string): boolean {
    if (!this.scenes.has(name)) return false;
    this.current = name; this.emit(); return true;
  }
  setLayer(id: string, patch: Partial<Omit<Layer, "id" | "source">>, scene = this.current): Layer | undefined {
    const l = this.scenes.get(scene)?.layers.find((x) => x.id === id);
    if (!l) return undefined;
    const clamp = (n: number) => Math.min(1, Math.max(0, n));
    if (patch.x !== undefined) l.x = clamp(patch.x);
    if (patch.y !== undefined) l.y = clamp(patch.y);
    if (patch.w !== undefined) l.w = clamp(patch.w);
    if (patch.h !== undefined) l.h = clamp(patch.h);
    if (patch.opacity !== undefined) l.opacity = clamp(patch.opacity);
    if (patch.visible !== undefined) l.visible = patch.visible;
    if (patch.text !== undefined) l.text = patch.text;
    this.emit();
    return l;
  }
  setOverlayText(text: string, visible = text.length > 0): void {
    for (const s of this.scenes.values()) {
      const l = s.layers.find((x) => x.id === "overlay");
      if (l) { l.text = text; l.visible = visible; }
    }
    this.emit();
  }
}
