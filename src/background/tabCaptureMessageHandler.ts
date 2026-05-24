import { isPngDataUrl, TAB_CAPTURE_SCREENSHOT_NAME, type TabCaptureVisibleResponse } from "../shared/tabCapture";

export async function handleTabCaptureVisibleMessage(): Promise<TabCaptureVisibleResponse> {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (typeof tab?.windowId !== "number") {
      return { ok: false, message: "未找到当前活动页面，无法截图" };
    }

    // Chrome 只会截取标签页内容的可见区域，Side Panel 不属于标签页渲染内容。
    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
    if (!isPngDataUrl(dataUrl)) {
      return { ok: false, message: "当前页面截图结果无效，请重试" };
    }

    return {
      ok: true,
      attachment: {
        id: `screenshot-${Date.now()}-${crypto.randomUUID()}`,
        name: TAB_CAPTURE_SCREENSHOT_NAME,
        mediaType: "image/png",
        dataUrl,
      },
    };
  } catch {
    return { ok: false, message: "当前页面无法截图，请切换到普通网页后重试" };
  }
}
