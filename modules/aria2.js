import axios from "axios";
import path from "path";

const ARIA2_RPC_URL = "http://localhost:6398/jsonrpc";

import { SAVE_DIR } from "./vars.js";

// ------------------ Core Aria2 Communication ------------------
const axiosPost = async (method, params = []) => {
  try {
    const { data } = await axios.post(ARIA2_RPC_URL, {
      jsonrpc: "2.0",
      method,
      id: 1,
      params,
    });
    return data;
  } catch (error) {
    console.error("Aria2 connection error:", error.message);
    return null;
  }
};

// ------------------ Aria2 API Functions ------------------
export const getGlobalStats = async () => {
  return await axiosPost("aria2.getGlobalStat");
};

export const downloadAria = async (id, url) => {
  const downloadDir = path.join(SAVE_DIR, id);
  const options = {
    dir: downloadDir,
  };

  return await axiosPost("aria2.addUri", [[url], options]);
};

export const getDownloadStatus = async (gid) => {
  return await axiosPost("aria2.tellStatus", [gid]);
};

export const getOngoingDownloads = async () => {
  return await axiosPost("aria2.tellActive");
};

export const cancelDownload = async (gid) => {
  return await axiosPost("aria2.remove", [gid]);
};

// ------------------ Aria2 Helper Functions ------------------
export const isAria2Available = async () => {
  try {
    const stats = await getGlobalStats();
    return stats && stats.result !== undefined;
  } catch (error) {
    console.error("Aria2 availability check failed:", error);
    return false;
  }
};
