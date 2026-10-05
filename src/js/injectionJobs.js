/*global html2canvas, domtoimage */
// Worker-owned functions injected through chrome.scripting; never strings or eval.
// eslint-disable-next-line no-unused-vars
var gsInjectionJobs = {
  youtubeTimestamp: function() {
    const video = document.querySelector('video.video-stream.html5-main-video');
    return video ? Math.floor(video.currentTime) : 0;
  },

  capturePreview: async function(screenCaptureMode, forceScreenCapture, useAlternateScreenCaptureLib, blockedHosts) {
    const body = document.body;
    if (!body) return { previewUrl: null, errorMsg: 'Page has no document body' };
    const maxHeight = forceScreenCapture ? 10000 : 5000;
    const width = Math.max(1, body.clientWidth || window.innerWidth);
    const height = screenCaptureMode === '2'
      ? Math.min(maxHeight, Math.max(window.innerHeight, body.scrollHeight,
        body.offsetHeight, document.documentElement.clientHeight,
        document.documentElement.scrollHeight, document.documentElement.offsetHeight))
      : window.innerHeight;
    const blockedImage = element => {
      if (!blockedHosts || element.nodeType !== 1 || !['IMG', 'SOURCE'].includes(element.tagName)) return false;
      const url = element.currentSrc || element.src || element.getAttribute('src');
      if (!url) return false;
      try {
        let host = new URL(url, document.baseURI).hostname.toLowerCase();
        while (host) {
          if (blockedHosts[host]) return true;
          const separator = host.indexOf('.');
          if (separator < 0) break;
          host = host.slice(separator + 1);
        }
      } catch (error) {
        return false;
      }
      return false;
    };
    try {
      let canvas;
      if (useAlternateScreenCaptureLib) {
        const rendered = await domtoimage.toCanvas(body, {
          width, height, filter: element => !blockedImage(element),
        });
        canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        canvas.getContext('2d').drawImage(rendered, 0, 0);
      } else {
        canvas = await html2canvas(body, {
          width, height, logging: false, imageTimeout: 10000,
          removeContainer: true, foreignObjectRendering: true,
          ignoreElements: blockedImage,
        });
      }
      const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
      let visible = false;
      for (let index = 0; index < pixels.length; index += 4) {
        if (pixels[index + 3] !== 0 &&
            (pixels[index] !== 255 || pixels[index + 1] !== 255 || pixels[index + 2] !== 255)) {
          visible = true;
          break;
        }
      }
      if (!visible) return { previewUrl: null, errorMsg: 'Canvas contains no visible pixels' };
      let previewUrl = canvas.toDataURL('image/webp', forceScreenCapture ? 0.92 : 0.5);
      if (!previewUrl || previewUrl === 'data:,') previewUrl = canvas.toDataURL();
      return previewUrl && previewUrl !== 'data:,'
        ? { previewUrl, errorMsg: null }
        : { previewUrl: null, errorMsg: 'Failed to generate preview image' };
    } catch (error) {
      return { previewUrl: null, errorMsg: error.message || String(error) };
    }
  },
};
