-- ═══ QMS v2 — Microsoft SQL Server Schema ════════════════════════════
-- Compatible with: SQL Server 2016+, Azure SQL Database, Windows Server
-- (the natural target for "on-prem Windows Server" deployments).

IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = 'qams_data')
BEGIN
  CREATE TABLE dbo.qams_data (
    bucket     NVARCHAR(255)  NOT NULL,
    data       NVARCHAR(MAX)  NOT NULL
               CONSTRAINT df_qams_data DEFAULT (N'[]'),
    updated_at DATETIMEOFFSET NOT NULL
               CONSTRAINT df_qams_updated DEFAULT SYSDATETIMEOFFSET(),
    CONSTRAINT pk_qams_data PRIMARY KEY CLUSTERED (bucket ASC)
  );

  ALTER TABLE dbo.qams_data
    ADD CONSTRAINT ck_qams_json CHECK (ISJSON(data) = 1);

  CREATE INDEX idx_qams_ts ON dbo.qams_data (updated_at DESC);
END
GO
