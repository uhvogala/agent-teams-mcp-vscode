import { z } from 'zod';
import { body, id } from './mcp';
import type { Team } from './team';

const readInput = z.object({ roomId: id.optional() }).strict();
const sendInput = z.object({ roomId: id, roleId: id, body }).strict();

export function readTeamForChat(team: Team, input: unknown) {
  const { roomId } = readInput.parse(input);
  const rooms = team.store.rooms();
  if (roomId === undefined) {
    return { rooms, roles: team.roster().map(({ id, name, activity }) => ({ id, name, activity })) };
  }
  const room = rooms.find(room => room.id === roomId);
  if (!room) throw new Error('Unknown team room. Use #agentTeamsRead without a room ID to list rooms.');
  return {
    room, members: team.store.roomMembers(roomId),
    recentMessages: team.store.transcript(roomId).slice(-10).map(({ id, author, body }) => ({ id, author, body })),
  };
}

export function prepareTeamChatMessage(team: Team, input: unknown) {
  const message = sendInput.parse(input);
  const room = team.store.rooms().find(room => room.id === message.roomId);
  if (!room || room.closed) throw new Error('The team room is closed or unavailable.');
  const role = team.roster().find(role => role.id === message.roleId);
  if (!role || !team.store.roomMembers(room.id).includes(role.id)) throw new Error('The recipient is not a member of this room.');
  if (role.activity !== 'Idle' && role.activity !== 'Busy') {
    throw new Error(`${role.name} is ${role.activity.toLowerCase()}. Start or resume that role from Agent Teams first.`);
  }
  return { message, room, role };
}

export function postTeamFromChat(team: Team, input: unknown) {
  const { message, role } = prepareTeamChatMessage(team, input);
  return { ...team.postHuman(message.roomId, message.body, [role.id]), roleId: role.id, roomId: message.roomId };
}
