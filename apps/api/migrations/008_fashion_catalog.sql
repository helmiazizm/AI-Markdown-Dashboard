DELETE FROM warehouse_relations
WHERE project = 'nike' AND schema_name = 'catalog' AND table_name = 'listings';

INSERT INTO warehouse_relations (
  project, schema_name, table_name, dataset_name, snapshot_column, grain, cautions, duckdb_file
) VALUES (
  'fashion', 'catalog', 'products', 'Fashion product catalog', NULL,
  'One row is one fashion catalog product from the public Hugging Face fashion-dataset.',
  '["This is a mixed-brand assortment, not a single retailer snapshot.","year is the collection year from the source, not a load snapshot date.","There are no price or stock fields in this grain."]'::jsonb,
  'fashion.duckdb'
)
ON CONFLICT (project, schema_name, table_name) DO NOTHING;
