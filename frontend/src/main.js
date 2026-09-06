import { createApp } from "vue";
import App from "./App.vue";
import router from "./router";
import "../../shared/raspechatka-theme.css";
import "./styles.css";
import "./theme-bridge.css";

createApp(App).use(router).mount("#app");
