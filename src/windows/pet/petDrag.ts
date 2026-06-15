type NativeDragOptions = {
  isSelfPet: boolean;
  setNativeDragging: (isDragging: boolean) => void;
  startWindowDrag: () => void;
  startDragLift: () => void;
};

export function startNativeWindowDragWithLift({
  isSelfPet,
  setNativeDragging,
  startWindowDrag,
  startDragLift,
}: NativeDragOptions) {
  setNativeDragging(true);
  startWindowDrag();
  if (isSelfPet) startDragLift();
}
