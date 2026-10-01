type NativeDragOptions = {
  isSelfPet: boolean;
  setNativeDragging: (isDragging: boolean) => void;
  startWindowDrag: () => void | Promise<void>;
  startDragLift: () => void;
};

export async function startNativeWindowDragWithLift({
  isSelfPet,
  setNativeDragging,
  startWindowDrag,
  startDragLift,
}: NativeDragOptions) {
  setNativeDragging(true);
  try {
    const dragging = startWindowDrag();
    if (isSelfPet) startDragLift();
    await dragging;
  } catch (error) {
    setNativeDragging(false);
    throw error;
  }
}
