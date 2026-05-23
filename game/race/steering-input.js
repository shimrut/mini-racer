export class SteeringInput {
  constructor() {
    this.keys = { left: false, right: false };
    this.sources = { left: new Set(), right: new Set() };
  }

  syncKeys() {
    this.keys.left = this.sources.left.size > 0;
    this.keys.right = this.sources.right.size > 0;
  }

  setSource(direction, sourceId, isDown) {
    const directionSources = this.sources[direction];
    if (!directionSources || !sourceId) return;
    if (isDown) directionSources.add(sourceId);
    else directionSources.delete(sourceId);
    this.syncKeys();
  }

  setTouch(direction, isDown) {
    this.setSource(direction, `touch:${direction}`, isDown);
  }

  getDirection(e) {
    const key = typeof e.key === "string" ? e.key.toLowerCase() : "";
    const code = typeof e.code === "string" ? e.code : "";

    if (
      key === "a" ||
      key === "arrowleft" ||
      key === "left" ||
      code === "KeyA" ||
      code === "ArrowLeft"
    ) {
      return "left";
    }
    if (
      key === "d" ||
      key === "arrowright" ||
      key === "right" ||
      code === "KeyD" ||
      code === "ArrowRight"
    ) {
      return "right";
    }
    return null;
  }

  getSourceId(e, direction) {
    if (typeof e.code === "string" && e.code) return `keyboard:${e.code}`;
    if (typeof e.key === "string" && e.key)
      return `keyboard:${e.key.toLowerCase()}`;
    return `keyboard:${direction}`;
  }

  clearSources() {
    this.sources.left.clear();
    this.sources.right.clear();
    this.syncKeys();
  }
}

