-- 문서자동화 엔진(회사양식 업로드→필드매핑→생성) 테이블 신설

-- CreateTable
CREATE TABLE "doc_templates" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "doc_type" TEXT NOT NULL,
    "format" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "master_file_path" TEXT NOT NULL,
    "field_schema_json" TEXT NOT NULL DEFAULT '[]',
    "section_keys_json" TEXT NOT NULL DEFAULT '[]',
    "table_binding_json" TEXT NOT NULL DEFAULT '{}',
    "default_visible_sections_json" TEXT NOT NULL DEFAULT '[]',
    "version" INTEGER NOT NULL DEFAULT 1,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_by" TEXT NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    "deleted_at" DATETIME,
    CONSTRAINT "doc_templates_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "doc_template_rules" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "template_id" TEXT NOT NULL,
    "name" TEXT NOT NULL DEFAULT '',
    "priority" INTEGER NOT NULL DEFAULT 0,
    "condition_json" TEXT NOT NULL DEFAULT '{}',
    "action_type" TEXT NOT NULL,
    "action_payload_json" TEXT NOT NULL DEFAULT '{}',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    "deleted_at" DATETIME,
    CONSTRAINT "doc_template_rules_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "doc_templates" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "doc_submissions" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "template_id" TEXT NOT NULL,
    "source_type" TEXT NOT NULL DEFAULT '',
    "source_id" TEXT NOT NULL DEFAULT '',
    "seq_no" TEXT NOT NULL DEFAULT '',
    "input_json" TEXT NOT NULL DEFAULT '{}',
    "render_plan_json" TEXT NOT NULL DEFAULT '{}',
    "output_file_path" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'SUCCESS',
    "error_message" TEXT NOT NULL DEFAULT '',
    "generated_by" TEXT NOT NULL,
    "generated_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "doc_submissions_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "doc_templates" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "doc_submissions_generated_by_fkey" FOREIGN KEY ("generated_by") REFERENCES "users" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "doc_sequence_counters" (
    "scope_key" TEXT NOT NULL PRIMARY KEY,
    "next_value" INTEGER NOT NULL DEFAULT 1,
    "updated_at" DATETIME NOT NULL
);

-- CreateIndex
CREATE INDEX "doc_templates_doc_type_idx" ON "doc_templates"("doc_type");

-- CreateIndex
CREATE INDEX "doc_template_rules_template_id_idx" ON "doc_template_rules"("template_id");

-- CreateIndex
CREATE INDEX "doc_submissions_template_id_idx" ON "doc_submissions"("template_id");

-- CreateIndex
CREATE INDEX "doc_submissions_source_type_source_id_idx" ON "doc_submissions"("source_type", "source_id");
