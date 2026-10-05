/*global gsBrowser, gsUtils, gsIndexedDb */
// eslint-disable-next-line no-unused-vars
var gsFavicon = (function() {
  'use strict';

  // const GOOGLE_S2_URL = 'https://www.google.com/s2/favicons?domain_url=';
  const FALLBACK_CHROME_FAVICON_META = {
    favIconUrl: 'img/chromeDefaultFavicon.png',
    isDark: true,
    normalisedDataUrl:
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAYklEQVQ4T2NkoBAwIuuPior6j8O8xmXLljVgk8MwYNmyZdgMfcjAwLAAmyFEGfDv3z9FJiamA9gMIcoAkKsiIiIUsBlClAHofkf2JkED0DWDAnrUgOEfBsRkTpzpgBjN6GoA24V1Efr1zoAAAAAASUVORK5CYII=',
    transparentDataUrl:
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAaUlEQVQ4T2NkoBAwIuuPioqqx2YeExPTwSVLlhzAJodhwLJlyxrRDWVkZPzIyMh4AZshRBnAxsY28ffv3wnYDCHKAJCrEhISBLAZQpQB6H5H9iZBA9A1gwJ61IDhHwbEZE6c6YAYzehqAAmQeBHM42eMAAAAAElFTkSuQmCC',
  };

  const _defaultFaviconFingerprintById = {};
  let _defaultChromeFaviconMeta;

  async function initAsPromised() {
    await addFaviconDefaults();
    gsUtils.log('gsFavicon', 'init successful');
  }

  async function addFaviconDefaults() {
    // Generate a list of potential 'default' favicons so we can avoid caching
    // anything that matches these defaults
    const defaultIconUrls = [
      generateChromeFavIconUrlFromUrl('http://chromeDefaultFavicon'),
      generateChromeFavIconUrlFromUrl('chromeDefaultFavicon'),
      gsBrowser.runtime.getURL('img/ic_suspendy_16x16.png'),
      gsBrowser.runtime.getURL('img/chromeDefaultFavicon.png'),
      gsBrowser.runtime.getURL('img/chromeDefaultFaviconSml.png'),
      gsBrowser.runtime.getURL('img/chromeDevDefaultFavicon.png'),
      gsBrowser.runtime.getURL('img/chromeDevDefaultFaviconSml.png'),
    ];

    await Promise.all(defaultIconUrls.map(async (iconUrl, index) => {
      const faviconMeta = await addDefaultFaviconMeta(iconUrl);
      if (index === 0) _defaultChromeFaviconMeta = faviconMeta || FALLBACK_CHROME_FAVICON_META;
    }));
  }

  async function addDefaultFaviconMeta(url) {
    let faviconMeta;
    try {
      faviconMeta = await gsUtils.executeWithRetries(
        buildFaviconMetaData,
        [url],
        4,
        0
      );
    } catch (e) {
      gsUtils.warning('gsFavicon', e);
    }
    if (faviconMeta) await addFaviconMetaToDefaultFingerprints(faviconMeta, url);
    return faviconMeta;
  }

  async function addFaviconMetaToDefaultFingerprints(faviconMeta, id) {
    _defaultFaviconFingerprintById[id] = await createImageFingerprint(
      faviconMeta.normalisedDataUrl
    );
    _defaultFaviconFingerprintById[
      id + 'Transparent'
    ] = await createImageFingerprint(faviconMeta.transparentDataUrl);
  }

  function generateChromeFavIconUrlFromUrl(url) {
    const faviconUrl = new URL(gsBrowser.runtime.getURL('/_favicon/'));
    faviconUrl.searchParams.set('pageUrl', url);
    faviconUrl.searchParams.set('size', '32');
    return faviconUrl.href;
  }

  async function getFaviconMetaData(tab) {
    if (gsUtils.isFileTab(tab)) {
      return _defaultChromeFaviconMeta;
    }

    // First try to fetch from cache
    let originalUrl = tab.url;
    if (gsUtils.isSuspendedTab(tab)) {
      originalUrl = gsUtils.getOriginalUrl(tab.url);
    }
    let faviconMeta = tab.incognito ? null : await getCachedFaviconMetaData(originalUrl);
    if (faviconMeta) {
      // gsUtils.log(
      //   tab.id,
      //   'Found favicon cache hit for url: ' + originalUrl,
      //   faviconMeta
      // );
      return faviconMeta;
    }

    // Else try to build from chrome's favicon cache
    faviconMeta = await buildFaviconMetaFromChromeFaviconCache(originalUrl);
    if (faviconMeta) {
      gsUtils.log(
        tab.id,
        'Saving browser favicon metadata into cache',
        faviconMeta
      );
      // Save to tgs favicon cache
      if (!tab.incognito) await saveFaviconMetaDataToCache(originalUrl, faviconMeta);
      return faviconMeta;
    }

    // Else try to build from tab.favIconUrl
    gsUtils.log(
      tab.id,
      'No entry in chrome favicon cache for url: ' + originalUrl
    );
    if (
      tab.favIconUrl &&
      tab.favIconUrl !== gsBrowser.runtime.getURL('img/ic_suspendy_16x16.png')
    ) {
      faviconMeta = await buildFaviconMetaFromTabFavIconUrl(tab.favIconUrl);
      if (faviconMeta) {
        gsUtils.log(
          tab.id,
          'Built faviconMeta from tab.favIconUrl',
          faviconMeta
        );
        return faviconMeta;
      }
    }

    // Else try to fetch from google
    // if (fallbackToGoogle) {
    //   const rootUrl = encodeURIComponent(gsUtils.getRootUrl(originalUrl));
    //   const tabFavIconUrl = GOOGLE_S2_URL + rootUrl;
    //   //TODO: Handle reject case below
    //   faviconMeta = await buildFaviconMetaData(tabFavIconUrl, 5000);
    //   faviconMetaValid = await isFaviconMetaValid(faviconMeta);
    //   if (faviconMetaValid) {
    //     gsUtils.log(
    //       tab.id,
    //       'Built faviconMeta from google.com/s2 service',
    //       faviconMeta
    //     );
    //     return faviconMeta;
    //   }
    // }

    // Else return the default chrome favicon
    gsUtils.log(tab.id, 'Failed to build faviconMeta. Using default icon');
    return _defaultChromeFaviconMeta;
  }

  async function buildFaviconMetaFromChromeFaviconCache(url) {
    const chromeFavIconUrl = generateChromeFavIconUrlFromUrl(url);
    gsUtils.log(
      'gsFavicon',
      `Building faviconMeta from url: ${chromeFavIconUrl}`
    );
    try {
      const faviconMeta = await buildFaviconMetaData(chromeFavIconUrl);
      const faviconMetaValid = await isFaviconMetaValid(faviconMeta);
      if (faviconMetaValid) {
        return faviconMeta;
      }
    } catch (e) {
      gsUtils.warning('gsUtils', e);
    }
    return null;
  }

  async function buildFaviconMetaFromTabFavIconUrl(favIconUrl) {
    try {
      const faviconMeta = await buildFaviconMetaData(favIconUrl);
      const faviconMetaValid = await isFaviconMetaValid(faviconMeta);
      if (faviconMetaValid) {
        return faviconMeta;
      }
    } catch (e) {
      gsUtils.warning('gsUtils', e);
    }
    return null;
  }

  async function getCachedFaviconMetaData(url) {
    const fullUrl = gsUtils.getRootUrl(url, true, false);
    let faviconMetaData = await gsIndexedDb.fetchFaviconMeta(fullUrl);
    if (!faviconMetaData) {
      const rootUrl = gsUtils.getRootUrl(url, false, false);
      faviconMetaData = await gsIndexedDb.fetchFaviconMeta(rootUrl);
    }
    return faviconMetaData || null;
  }

  async function saveFaviconMetaDataToCache(url, faviconMeta) {
    const fullUrl = gsUtils.getRootUrl(url, true, false);
    const rootUrl = gsUtils.getRootUrl(url, false, false);
    gsUtils.log(
      'gsFavicon',
      'Saving favicon cache entry for: ' + fullUrl,
      faviconMeta
    );
    await gsIndexedDb.addFaviconMeta(fullUrl, Object.assign({}, faviconMeta));
    await gsIndexedDb.addFaviconMeta(rootUrl, Object.assign({}, faviconMeta));
  }

  // dont use this function as it causes rate limit issues
  // eslint-disable-next-line no-unused-vars
  // function fetchFallbackFaviconDataUrl(url) {
  //   return new Promise(resolve => {
  //     let imageLoaded = false;
  //
  //     const rootUrl = gsUtils.encodeString(gsUtils.getRootUrl(url));
  //     const requestUrl = GOOGLE_S2_URL + rootUrl;
  //
  //     const xmlHTTP = new XMLHttpRequest();
  //     xmlHTTP.open('GET', requestUrl, true);
  //
  //     xmlHTTP.responseType = 'arraybuffer';
  //     xmlHTTP.onload = function(e) {
  //       imageLoaded = true;
  //       const arr = new Uint8Array(xmlHTTP.response);
  //       const raw = String.fromCharCode.apply(null, arr);
  //       const b64 = btoa(raw);
  //       const dataUrl = 'data:image/png;base64,' + b64;
  //       resolve(dataUrl);
  //     };
  //     xmlHTTP.send();
  //     setTimeout(() => {
  //       if (!imageLoaded) {
  //         gsUtils.log('gsFavicon', 'Failed to load image from: ' + url);
  //         resolve(null);
  //       }
  //     }, 3000);
  //   });
  // }

  async function isFaviconMetaValid(faviconMeta) {
    if (
      !faviconMeta ||
      faviconMeta.normalisedDataUrl === 'data:,' ||
      faviconMeta.transparentDataUrl === 'data:,'
    ) {
      return false;
    }
    const normalisedFingerprint = await createImageFingerprint(
      faviconMeta.normalisedDataUrl
    );
    const transparentFingerprint = await createImageFingerprint(
      faviconMeta.transparentDataUrl
    );

    for (let id of Object.keys(_defaultFaviconFingerprintById)) {
      const defaultFaviconFingerprint = _defaultFaviconFingerprintById[id];
      if (
        normalisedFingerprint === defaultFaviconFingerprint ||
        transparentFingerprint === defaultFaviconFingerprint
      ) {
        gsUtils.log(
          'gsFavicon',
          'FaviconMeta not valid as it matches fingerprint of default favicon: ' +
            id,
          faviconMeta
        );
        return false;
      }
    }
    return true;
  }

  // Turns the img into a 16x16 black and white dataUrl
  function createImageFingerprint(dataUrl) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onerror = () => reject(new Error('Failed to decode favicon fingerprint image'));
      img.onload = function() {
        try {
          const canvas = document.createElement('canvas');
          const context = canvas.getContext('2d');
          const threshold = 80;
          canvas.width = 16;
          canvas.height = 16;
          context.drawImage(img, 0, 0, 16, 16);
          const imageData = context.getImageData(0, 0, 16, 16);
          for (let i = 0; i < imageData.data.length; i += 4) {
            const luma = Math.floor(imageData.data[i] * 0.3 +
              imageData.data[i + 1] * 0.59 + imageData.data[i + 2] * 0.11);
            imageData.data[i] = imageData.data[i + 1] = imageData.data[i + 2] =
              luma > threshold ? 255 : 0;
            imageData.data[i + 3] = 255;
          }
          context.putImageData(imageData, 0, 0);
          resolve(canvas.toDataURL('image/png'));
        } catch (error) {
          reject(error);
        }
      };
      img.src = dataUrl;
    });
  }

  async function buildFaviconMetaData(url) {
    const controller = new AbortController();
    const fetchTimeout = setTimeout(() => controller.abort(), 5000);
    let blobUrl;
    let decodeTimeout;
    try {
      const response = await fetch(url, { signal: controller.signal, credentials: 'omit' });
      if (!response.ok) throw new Error('Failed to fetch favicon: ' + response.status);
      blobUrl = URL.createObjectURL(await response.blob());
      return await new Promise((resolve, reject) => {
        const img = new Image();
        img.onerror = () => reject(new Error('Failed to decode favicon: ' + url));
        img.onload = () => {
          try {
            const canvas = document.createElement('canvas');
            canvas.width = img.width;
            canvas.height = img.height;
            const context = canvas.getContext('2d');
            context.drawImage(img, 0, 0);
            const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
            const pixels = imageData.data;
            let light = 0;
            let dark = 0;
            let maxAlpha = 0;
            for (let index = 0; index < pixels.length; index += 4) {
              if (Math.max(pixels[index], pixels[index + 1], pixels[index + 2]) < 128 ||
                  pixels[index + 3] < 128) dark++;
              else light++;
              maxAlpha = Math.max(maxAlpha, pixels[index + 3]);
            }
            if (!maxAlpha) throw new Error('Favicon is completely transparent: ' + url);
            for (let index = 3; index < pixels.length; index += 4) {
              pixels[index] = Math.floor(pixels[index] * 255 / maxAlpha);
            }
            context.putImageData(imageData, 0, 0);
            const normalisedDataUrl = canvas.toDataURL('image/png');
            for (let index = 3; index < pixels.length; index += 4) {
              pixels[index] = Math.floor(pixels[index] * 0.5);
            }
            context.putImageData(imageData, 0, 0);
            resolve({
              favIconUrl: url,
              isDark: (light - dark) / (canvas.width * canvas.height) + 0.1 < 0,
              normalisedDataUrl,
              transparentDataUrl: canvas.toDataURL('image/png'),
            });
          } catch (error) {
            reject(error);
          }
        };
        decodeTimeout = setTimeout(() => reject(new Error('Favicon decoding timed out: ' + url)), 5000);
        img.src = blobUrl;
      });
    } finally {
      clearTimeout(fetchTimeout);
      clearTimeout(decodeTimeout);
      if (blobUrl) URL.revokeObjectURL(blobUrl);
    }
  }

  return {
    initAsPromised,
    getFaviconMetaData,
    generateChromeFavIconUrlFromUrl,
    buildFaviconMetaFromChromeFaviconCache,
    saveFaviconMetaDataToCache,
  };
})();
