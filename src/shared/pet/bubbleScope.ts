export type BubbleScope = { viewerId: string; roomId: string; senderId: string };
export function bubbleScopeKey(scope: BubbleScope): string { return JSON.stringify([scope.viewerId, scope.roomId, scope.senderId]); }
