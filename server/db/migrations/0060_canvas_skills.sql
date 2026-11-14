CREATE TABLE "canvas_skills" (
	"canvas_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"markdown" text NOT NULL,
	"updated_at" bigint NOT NULL,
	"updated_by" text NOT NULL,
	CONSTRAINT "canvas_skills_canvas_id_name_pk" PRIMARY KEY("canvas_id","name")
);
