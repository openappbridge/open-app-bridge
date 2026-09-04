import type {
  ContentInput,
  OabError,
  ReceiverDeclaration,
} from "./index.js";

export type ShareWidgetContent = ContentInput;
export type ShareWidgetContentProvider = () =>
  | ShareWidgetContent
  | Promise<ShareWidgetContent>;

export interface ShareWidgetEventMap {
  "oab-open": CustomEvent<Readonly<Record<string, never>>>;
  "oab-close": CustomEvent<Readonly<Record<string, never>>>;
  "oab-receiver-verified": CustomEvent<
    Readonly<{ origin: string; declaration: ReceiverDeclaration }>
  >;
  "oab-launched": CustomEvent<
    Readonly<{
      origin: string;
      requestId: string;
      transport: "link-envelope/1";
      receiptAvailable: false;
    }>
  >;
  "oab-previewing": CustomEvent<
    Readonly<{
      origin: string;
      requestId: string;
      transferId: string;
      transport: "detached-datachannel/1";
    }>
  >;
  "oab-result": CustomEvent<
    Readonly<{
      origin: string;
      requestId: string;
      transferId: string;
      transport: "detached-datachannel/1";
      disposition: "preserved" | "discarded";
    }>
  >;
  "oab-error": CustomEvent<
    Readonly<{ code: string; message: string; error: OabError }>
  >;
  "oab-destination-removed": CustomEvent<Readonly<{ origin: string }>>;
}

export class OpenAppShareElement extends HTMLElement {
  content: ShareWidgetContent | null;
  contentProvider: ShareWidgetContentProvider | null;
  detachedEnabled: boolean;
  discoveryTimeoutMs: number;
  applicationManifestTimeoutMs: number;
  applicationIconTimeoutMs: number;
  open(
    contentOverride?: ShareWidgetContent | ShareWidgetContentProvider,
  ): Promise<void>;
  openFor(
    destination: string,
    contentOverride?: ShareWidgetContent | ShareWidgetContentProvider,
  ): Promise<void>;
  close(): void;
  clearDestinations(): void;
  addEventListener<K extends keyof ShareWidgetEventMap>(
    type: K,
    listener: (this: OpenAppShareElement, event: ShareWidgetEventMap[K]) => void,
    options?: boolean | AddEventListenerOptions,
  ): void;
  addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: boolean | AddEventListenerOptions,
  ): void;
}

export function defineOpenAppShareElement(
  registry?: CustomElementRegistry,
): CustomElementConstructor | null;

declare global {
  interface HTMLElementTagNameMap {
    "oab-share": OpenAppShareElement;
  }
}
