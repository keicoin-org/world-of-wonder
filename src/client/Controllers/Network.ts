// colyseus
import { Client, Room } from "colyseus.js";
import { socketUrl } from "../Utils";
import { ServerMsg } from "../../shared/types";

export class Network {
    public _client: Client;

    constructor(port) {
        // create colyseus client
        //
        // The socket does not necessarily point at wherever the page came from:
        // hosted as an example, the client is static on one origin and the rooms
        // run on another.
        this._client = new Client(socketUrl(port));
    }

    public async joinRoom(roomId, token, character_id): Promise<any> {
        return await this._client.joinById(roomId, {
            token: token,
            character_id: character_id,
        });
    }

    public async joinChatRoom(data): Promise<any> {
        return await this._client.joinOrCreate("chat_room", data);
    }

    public async findCurrentRoom(currentRoomKey): Promise<any> {
        return new Promise(async (resolve: any, reject: any) => {
            let rooms = await this._client.getAvailableRooms("game_room");
            if (rooms.length > 0) {
                rooms.forEach((room) => {
                    if (room.metadata.location === currentRoomKey) {
                        resolve(room);
                    }
                });
            }
            resolve(false);
        });
    }

    public async joinOrCreateRoom(location, token, character_id): Promise<any> {
        // find all exisiting rooms
        let rooms = await this._client.getAvailableRooms("game_room");

        // rooms exists
        if (rooms.length > 0) {
            // do we already have a room for the specified location
            let roomIdFound: boolean | string = false;
            rooms.forEach((room) => {
                if (room.metadata.location === location) {
                    roomIdFound = room.roomId;
                }
            });

            // if so, let's join it
            if (roomIdFound !== false) {
                return await this.joinRoom(roomIdFound, token, character_id);
            }
        }

        // else create a new room for that location
        return await this._client.create("game_room", {
            location: location,
            token: token,
            character_id: character_id,
        });
    }
}
