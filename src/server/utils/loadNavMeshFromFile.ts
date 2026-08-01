///////////////////////////////////////////////////////////
// CAPTAIN OBVIOUS HERE:
// this can only be used in a NODE ENVIRONMENT, do not use to import in the client as fs is not available.

import fs from "fs";
import path from "path";
import { NavMeshLoader, NavMesh } from "../../shared/Libs/yuka-min";

/**
 * Navmeshes are read from `public/` relative to where the server was started,
 * which is the same place `database/sqllite.sql` is read from.
 *
 * This used to walk up from `__dirname`. That worked while the server was a tree
 * of files emitted by tsc and stopped working when it became one bundle: the
 * depth it counted on is gone, and `__dirname` does not exist in an ES module at
 * all, so the first room to load a navmesh threw a ReferenceError.
 */
export default async function loadNavMeshFromFile(fileNameNavMesh: string): Promise<NavMesh> {
    const url = path.join(process.cwd(), "public/models/navmesh/", fileNameNavMesh + ".glb");
    if (!fs.existsSync(url)) {
        throw new Error(
            `No navmesh at ${url} — the server reads public/ from its working directory, so start it from the project root.`
        );
    }
    const data = await fs.readFileSync(url);
    const loader = new NavMeshLoader();
    return loader.parse(data.buffer, "", { mergeConvexRegions: false }).then((navmesh) => {
        return navmesh;
    });
}
