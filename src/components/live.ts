import { CSSResultGroup, LitElement, TemplateResult, html, unsafeCSS } from 'lit';
import type { ExtendedHomeAssistant, FrigateCardConfig } from '../types.js';
import { HomeAssistant } from 'custom-card-helpers';
import { customElement, property } from 'lit/decorators.js';
import { until } from 'lit/directives/until.js';

import { localize } from '../localize/localize.js';
import {
  dispatchErrorMessageEvent,
  dispatchMediaShowEvent,
  dispatchMessageEvent,
  dispatchPauseEvent,
  dispatchPlayEvent,
  homeAssistantSignPath,
} from '../common.js';
import { renderProgressIndicator } from '../components/message.js';

import JSMpeg from '@cycjimmy/jsmpeg-player';

import liveStyle from '../scss/live.scss';

// Number of seconds a signed URL is valid for.
const URL_SIGN_EXPIRY_SECONDS = 24 * 60 * 60;

// Number of seconds before the expiry to trigger a refresh.
const URL_SIGN_REFRESH_THRESHOLD_SECONDS = 1 * 60 * 60;

@customElement('frigate-card-live')
export class FrigateCardLive extends LitElement {
  @property({ attribute: false })
  protected hass!: HomeAssistant & ExtendedHomeAssistant;

  @property({ attribute: false })
  protected config!: FrigateCardConfig;

  @property({ attribute: false })
  protected frigateCameraName!: string;

  protected render(): TemplateResult | void {
    return html` ${this.config.live_provider == 'frigate'
      ? html` <frigate-card-live-frigate
          .hass=${this.hass}
          .cameraEntity=${this.config.camera_entity}
        >
        </frigate-card-live-frigate>`
      : this.config.live_provider == 'webrtc'
      ? html`<frigate-card-live-webrtc
          .hass=${this.hass}
          .webRTCConfig=${this.config.webrtc || {}}
        >
        </frigate-card-live-webrtc>`
      : html` <frigate-card-live-jsmpeg
          .hass=${this.hass}
          .cameraName=${this.frigateCameraName}
          .clientId=${this.config.frigate_client_id}
        >
        </frigate-card-live-jsmpeg>`}`;
  }

  static get styles(): CSSResultGroup {
    return unsafeCSS(liveStyle);
  }
}

@customElement('frigate-card-live-frigate')
export class FrigateCardLiveFrigate extends LitElement {
  @property({ attribute: false })
  protected hass!: HomeAssistant & ExtendedHomeAssistant;

  @property({ attribute: false })
  protected cameraEntity?: string;

  protected render(): TemplateResult | void {
    if (!this.cameraEntity || !(this.cameraEntity in this.hass.states)) {
      return dispatchMessageEvent(
        this,
        localize('error.no_live_camera'),
        'mdi:camera-off',
      );
    }
    return html` <frigate-card-ha-camera-stream
      .hass=${this.hass}
      .stateObj=${this.hass.states[this.cameraEntity]}
      .controls=${true}
      .muted=${true}
    >
    </frigate-card-ha-camera-stream>`;
  }

  static get styles(): CSSResultGroup {
    return unsafeCSS(liveStyle);
  }
}

// Create a wrapper for the WebRTC element
//  - https://github.com/AlexxIT/WebRTC
@customElement('frigate-card-live-webrtc')
export class FrigateCardLiveWebRTC extends LitElement {
  @property({ attribute: false })
  protected webRTCConfig!: Record<string, unknown>;

  protected hass!: HomeAssistant & ExtendedHomeAssistant;
  protected _webRTCElement: HTMLElement | null = null;

  protected _createWebRTC(): TemplateResult | void {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const webrtcElement = customElements.get('webrtc-camera') as any;
    if (webrtcElement) {
      const webrtc = new webrtcElement();
      webrtc.setConfig(this.webRTCConfig);
      webrtc.hass = this.hass;
      this._webRTCElement = webrtc;
    } else {
      throw new Error(localize('error.missing_webrtc'));
    }
  }

  protected render(): TemplateResult | void {
    if (!this._webRTCElement) {
      try {
        this._createWebRTC();
      } catch (e) {
        return dispatchErrorMessageEvent(this, (e as Error).message);
      }
    }
    return html`${this._webRTCElement}`;
  }

  public updated(): void {
    // Extract the video component after it has been rendered and generate the
    // media load event.
    this.updateComplete.then(() => {
      const video = this.renderRoot.querySelector('#video') as HTMLVideoElement;
      if (video) {
        const onloadedmetadata = video.onloadedmetadata;
        const onplay = video.onplay;
        const onpause = video.onpause;

        video.onloadedmetadata = (e) => {
          if (onloadedmetadata) {
            onloadedmetadata.call(video, e);
          }
          dispatchMediaShowEvent(this, video);
        };
        video.onplay = (e) => {
          if (onplay) {
            onplay.call(video, e);
          }
          dispatchPlayEvent(this);
        };
        video.onpause = (e) => {
          if (onpause) {
            onpause.call(video, e);
          }
          dispatchPauseEvent(this);
        };
      }
    });
  }

  static get styles(): CSSResultGroup {
    return unsafeCSS(liveStyle);
  }
}

@customElement('frigate-card-live-jsmpeg')
export class FrigateCardLiveJSMPEG extends LitElement {
  @property({ attribute: false })
  protected cameraName!: string;

  @property({ attribute: false })
  protected clientId!: string;

  protected hass!: HomeAssistant & ExtendedHomeAssistant;
  protected _jsmpegCanvasElement?: HTMLCanvasElement;
  protected _jsmpegVideoPlayer?: JSMpeg.VideoElement;
  protected _jsmpegURL?: string | null;
  protected _refreshPlayerTimerID?: number;

  protected async _getURL(): Promise<string | null> {
    if (!this.hass) {
      return null;
    }

    let response: string | null | undefined;
    try {
      response = await homeAssistantSignPath(
        this.hass,
        `/api/frigate/${this.clientId}` + `/jsmpeg/${this.cameraName}`,
        URL_SIGN_EXPIRY_SECONDS);
    } catch (err) {
      console.warn(err);
      return null;
    }
    if (!response) {
      return null;
    }
    return response.replace(/^http/i, 'ws');
  }

  protected _createJSMPEGPlayer(): JSMpeg.VideoElement {
    let videoDecoded = false;
    return new JSMpeg.VideoElement(
      this,
      this._jsmpegURL,
      {
        preserveDrawingBuffer: true,
        canvas: this._jsmpegCanvasElement,
        hooks: {
          play: () => {
            dispatchPlayEvent(this);
          },
          pause: () => {
            dispatchPauseEvent(this);
          },
        },
      },
      {
        pauseWhenHidden: false,
        protocols: [],
        audio: false,
        videoBufferSize: 1024 * 1024 * 4,
        onVideoDecode: () => {
          // This is the only callback that is called after the dimensions
          // are available. It's called on every frame decode, so just
          // ignore any subsequent calls.
          if (!videoDecoded && this._jsmpegCanvasElement) {
            videoDecoded = true;
            dispatchMediaShowEvent(this, this._jsmpegCanvasElement);
          }
        },
      },
    );
  }

  protected _resetPlayer(): void {
    if (this._refreshPlayerTimerID) {
      window.clearTimeout(this._refreshPlayerTimerID);
      this._refreshPlayerTimerID = undefined;
    }
    if (this._jsmpegVideoPlayer) {
      this._jsmpegVideoPlayer.destroy();
      this._jsmpegVideoPlayer = undefined;
    }
    if (this._jsmpegCanvasElement) {
      this._jsmpegCanvasElement.remove();
      this._jsmpegCanvasElement = undefined;
    }
    this._jsmpegURL = undefined;
  }

  connectedCallback(): void {
    super.connectedCallback();
    if (this.isConnected) {
      this.requestUpdate();
    }
  }

  disconnectedCallback(): void {
    if (!this.isConnected) {
      this._resetPlayer();
    }
    super.disconnectedCallback();
  }

  protected async _refreshPlayer(): Promise<void> {
    this._resetPlayer();

    this._jsmpegCanvasElement = document.createElement('canvas');
    this._jsmpegCanvasElement.className = 'media';

    this._jsmpegURL = await this._getURL();
    if (this._jsmpegURL) {
      this._jsmpegVideoPlayer = this._createJSMPEGPlayer();

      this._refreshPlayerTimerID = window.setTimeout(() => {
        this._refreshPlayer();
      }, (URL_SIGN_EXPIRY_SECONDS - URL_SIGN_REFRESH_THRESHOLD_SECONDS) * 1000);
    }
    this.requestUpdate();
  }

  protected render(): TemplateResult | void {
    if (
      this._jsmpegURL === undefined ||
      !this._jsmpegVideoPlayer ||
      !this._jsmpegCanvasElement
    ) {
      return html`${until(this._refreshPlayer(), renderProgressIndicator())}`;
    }
    if (!this._jsmpegURL) {
      return dispatchErrorMessageEvent(this, localize('error.jsmpeg_no_sign'));
    }
    if (!this._jsmpegVideoPlayer || !this._jsmpegCanvasElement) {
      return dispatchErrorMessageEvent(this, localize('error.jsmpeg_no_player'));
    }
    return html`${this._jsmpegCanvasElement}`;
  }

  static get styles(): CSSResultGroup {
    return unsafeCSS(liveStyle);
  }
}
