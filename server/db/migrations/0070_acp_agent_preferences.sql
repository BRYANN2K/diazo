CREATE TABLE "acp_agent_preferences" (
	"user_id" text NOT NULL,
	"agent" text NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"model" text DEFAULT 'default' NOT NULL,
	"effort" text,
	CONSTRAINT "acp_agent_preferences_user_id_agent_pk" PRIMARY KEY("user_id","agent")
);
