import type { Forecast } from "@meetsanctum/app-sdk";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

// Weather's own database: where the forecast the core keeps is for, so that
// after a restart another place's forecast is never taken for the home's,
// and the last forecast it fetched, so its card can be worked out again
// while Open-Meteo cannot be reached. The coordinates stay here, out of the
// forecast, which every client sees.
export const forecastLocation = sqliteTable("forecast_location", {
  id: integer("id").primaryKey(),
  location: text("location").notNull(),
  forecast: text("forecast", { mode: "json" }).$type<Forecast>(),
});
