export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");

  link.href = url;
  link.download = filename;
  link.style.display = "none";
  document.body.appendChild(link);
  try {
    link.click();
  } finally {
    document.body.removeChild(link);
    // Blob URL 属于页面资源，即使下载触发失败也要释放，避免 Side Panel 长时间打开时累积内存。
    URL.revokeObjectURL(url);
  }
}
