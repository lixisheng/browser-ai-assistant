import type { ChatImageAttachment } from "./types";

export const TAB_CAPTURE_VISIBLE_MESSAGE_TYPE = "tab.captureVisible";
export const TAB_CAPTURE_SCREENSHOT_NAME = "当前标签页截图.png";

export interface TabCaptureVisibleMessage {
  type: typeof TAB_CAPTURE_VISIBLE_MESSAGE_TYPE;
}

export type TabCaptureVisibleResponse =
  | {
      ok: true;
      attachment: ChatImageAttachment;
    }
  | {
      ok: false;
      message: string;
    };

export function isPngDataUrl(value: unknown): value is string {
  return typeof value === "string" && /^data:image\/png;base64,(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value);
}

export function isTabCaptureImageAttachment(value: unknown): value is ChatImageAttachment {
  if (!value || typeof value !== "object") {
    return false;
  }

  const attachment = value as Partial<ChatImageAttachment>;
  return (
    typeof attachment.id === "string" &&
    attachment.id.length > 0 &&
    attachment.name === TAB_CAPTURE_SCREENSHOT_NAME &&
    attachment.mediaType === "image/png" &&
    typeof attachment.dataUrl === "string" &&
    attachment.dataUrl.startsWith("data:image/png;base64,")
  );
}
