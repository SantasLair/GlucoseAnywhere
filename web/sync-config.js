// OAuth client IDs for the optional insulin-log sync. Leave a provider's ID empty and its button stays hidden.
// These are public identifiers, not secrets. Register your own (see README, "Cloud sync of the insulin log").
export const CLIENT_IDS = {
  google: '414358425331-2l5eplcat1om1i93agdmquh3anr25uin.apps.googleusercontent.com',      // Google Cloud console: OAuth client, type "Web application"; scope drive.appdata
  microsoft: '',   // Entra admin center: app registration, platform "Single-page application"; scopes Files.ReadWrite.AppFolder, offline_access
};
