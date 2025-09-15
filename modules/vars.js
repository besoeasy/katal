import path from "path";
import os from "os";

export const SAVE_DIR = path.join(os.tmpdir(), "katal");
export const SERVERPORT = process.env.SERVERPORT || 6799;
export const WEBPORT = process.env.WEBPORT || 6798;
export const SMBPORT = process.env.SMBPORT || 445;

