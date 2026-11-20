'use client';

import { io, type Socket } from 'socket.io-client';
import { API_BASE, tokenStore } from './api';

let socket: Socket | null = null;
let socketToken: string | null = null;

/** One authenticated Socket.IO connection per browser tab (the server joins the private `user:{id}` room itself). */
export function getSocket(): Socket | null {
  const token = tokenStore.get();
  if (!token) return null;
  if (socket && socketToken !== token) {
    socket.disconnect();
    socket = null;
  }
  if (!socket) {
    socketToken = token;
    socket = io(API_BASE || undefined, { auth: { token }, transports: ['websocket', 'polling'] });
  }
  return socket;
}

export function closeSocket(): void {
  socket?.disconnect();
  socket = null;
  socketToken = null;
}
