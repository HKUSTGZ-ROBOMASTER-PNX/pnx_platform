export function cameraConstraints(deviceId = '', resolution = '1280x720', fps = 30, fallback = false) {
  const match = /^(640x480|1280x720|1920x1080)$/.exec(resolution);
  if (!match || ![15, 30, 60].includes(Number(fps))) throw new Error('不支持的摄像头采集参数');
  const [width, height] = resolution.split('x').map(Number);
  return { audio: false, video: { ...(deviceId ? { deviceId: { exact: deviceId } } : {}), ...(fallback ? {} : { width: { ideal: width }, height: { ideal: height }, frameRate: { ideal: Number(fps) } }) } };
}
export function cameraError(error) {
  return ({ NotAllowedError: '摄像头权限被拒绝。请允许当前页面及系统隐私设置中的摄像头访问。',
    NotFoundError: '未找到摄像头。手机需开启 USB 网络摄像头模式或安装配套虚拟摄像头驱动，然后刷新列表。',
    NotReadableError: '摄像头无法读取，可能被其他应用占用，或设备驱动未就绪。',
    OverconstrainedError: '所选摄像头或采集规格不可用，请刷新设备后重新选择。',
    AbortError: '摄像头连接已取消，请重试。' })[error?.name] || error?.message || '摄像头连接失败';
}
export function receiverPixels(buffer) {
  if (!(buffer instanceof ArrayBuffer) || buffer.byteLength < 16) throw new Error('图传帧不完整');
  const view = new DataView(buffer), width = view.getUint32(4, true), height = view.getUint32(8, true), length = view.getUint32(12, true);
  if (view.getUint32(0, true) !== 0x31464250 || !width || !height || width > 3840 || height > 2160 || length !== width * height * 3 || length + 16 !== buffer.byteLength) throw new Error('图传帧格式不匹配');
  const rgb = new Uint8Array(buffer, 16), rgba = new Uint8ClampedArray(width * height * 4);
  for (let i = 0, j = 0; i < rgb.length; i += 3, j += 4) { rgba[j] = rgb[i]; rgba[j + 1] = rgb[i + 1]; rgba[j + 2] = rgb[i + 2]; rgba[j + 3] = 255; }
  return { width, height, rgba };
}
