import { describe, expect, it, vi } from "vitest";
import { createRoomVisibilityController } from "./roomVisibility.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function setup(roomId: string | null) {
  const deps = {
    getRoomId: () => roomId,
    prepare: vi.fn(async () => {}),
    setVisible: vi.fn(async (_visible: boolean) => {}),
    notify: vi.fn(async (_roomId: string | null) => {}),
  };
  return { deps, controller: createRoomVisibilityController(deps), setRoom: (next: string | null) => { roomId = next; } };
}

describe("房间与自己窗口显隐", () => {
  it("无房间启动不准备气泡窗口，保持宠物隐藏", async () => {
    const { deps, controller } = setup(null);
    await controller.sync();
    expect(deps.prepare).not.toHaveBeenCalled();
    expect(deps.setVisible).toHaveBeenCalledWith(false);
    expect(deps.notify).toHaveBeenCalledWith(null);
  });

  it("恢复房间必须等气泡创建完成才显示和通知", async () => {
    const { deps, controller } = setup("room-a");
    const started = deferred();
    const finished = deferred();
    deps.prepare.mockImplementation(async () => { started.resolve(); await finished.promise; });
    const sync = controller.sync();
    await started.promise;
    expect(deps.setVisible).not.toHaveBeenCalled();
    expect(deps.notify).not.toHaveBeenCalled();
    finished.resolve();
    await sync;
    expect(deps.setVisible).toHaveBeenCalledWith(true);
    expect(deps.notify).toHaveBeenCalledWith("room-a");
  });

  it("气泡创建期间退出，迟到的创建完成后仍隐藏宠物", async () => {
    const { deps, controller, setRoom } = setup("room-a");
    const started = deferred();
    const finished = deferred();
    deps.prepare.mockImplementation(async () => { started.resolve(); await finished.promise; });
    const enter = controller.sync();
    await started.promise;
    setRoom(null);
    const leave = controller.sync();
    finished.resolve();
    await Promise.all([enter, leave]);
    expect(deps.setVisible.mock.calls).toEqual([[false], [false]]);
    expect(deps.prepare).toHaveBeenCalledTimes(1);
    expect(deps.notify).toHaveBeenLastCalledWith(null);
  });

  it("窗口准备失败不会阻塞后续退出和重试", async () => {
    const { deps, controller, setRoom } = setup("room-a");
    deps.prepare.mockRejectedValueOnce(new Error("spawn failed"));
    await expect(controller.sync()).rejects.toThrow("spawn failed");
    setRoom(null);
    await controller.sync();
    expect(deps.setVisible).toHaveBeenLastCalledWith(false);
    setRoom("room-b");
    await controller.sync();
    expect(deps.setVisible).toHaveBeenLastCalledWith(true);
    expect(deps.notify).toHaveBeenLastCalledWith("room-b");
  });
});
