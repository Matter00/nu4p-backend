import Fastify from "fastify";
import cors from "@fastify/cors";
import { Server } from "socket.io";
import { z } from "zod";
import { prisma } from "./lib/prisma.js";

const app = Fastify({ logger: true });

// 👉 PAS DIT AAN ALS JE SANDBOX URL VERANDERT
const FRONTEND_ORIGIN = "https://q648dn.csb.app";

// ✅ CORS FIX (BELANGRIJK)
await app.register(cors, {
  origin: [FRONTEND_ORIGIN],
  methods: ["GET", "POST", "PATCH", "OPTIONS"],
  allowedHeaders: ["Content-Type"],
  credentials: false,
});

// health check
app.get("/health", async () => {
  return { ok: true };
});

// classes ophalen
app.get("/classes", async () => {
  const classes = await prisma.schoolClass.findMany({
    orderBy: { name: "asc" },
    include: {
      students: { orderBy: { name: "asc" } },
      tasks: { orderBy: { name: "asc" } },
      taskStatuses: true,
    },
  });

  return classes.map((schoolClass) => ({
    id: schoolClass.id,
    name: schoolClass.name,
    studentPassword: schoolClass.studentPassword,
    teacherPassword: schoolClass.teacherPassword,
    students: schoolClass.students.map((s) => s.name),
    tasks: schoolClass.tasks.map((t) => t.name),
    grid: Object.fromEntries(
      schoolClass.students.map((student) => [
        student.name,
        Object.fromEntries(
          schoolClass.tasks.map((task) => {
            const match = schoolClass.taskStatuses.find(
              (ts) => ts.studentId === student.id && ts.taskId === task.id
            );
            return [task.name, match?.status ?? "red"];
          })
        ),
      ])
    ),
  }));
});

// status update schema
const updateStatusSchema = z.object({
  className: z.string().min(1),
  studentName: z.string().min(1),
  taskName: z.string().min(1),
  status: z.enum(["red", "green", "orange"]),
});

let io: Server;

// status update endpoint
app.patch("/status", async (request, reply) => {
  const parsed = updateStatusSchema.safeParse(request.body);

  if (!parsed.success) {
    return reply.status(400).send({
      error: "Ongeldige input",
      details: parsed.error.flatten(),
    });
  }

  const { className, studentName, taskName, status } = parsed.data;

  const schoolClass = await prisma.schoolClass.findUnique({
    where: { name: className },
    include: {
      students: true,
      tasks: true,
    },
  });

  if (!schoolClass) {
    return reply.status(404).send({ error: "Klas niet gevonden" });
  }

  const student = schoolClass.students.find((s) => s.name === studentName);
  if (!student) {
    return reply.status(404).send({ error: "Leerling niet gevonden" });
  }

  const task = schoolClass.tasks.find((t) => t.name === taskName);
  if (!task) {
    return reply.status(404).send({ error: "Taak niet gevonden" });
  }

  const updated = await prisma.taskStatus.upsert({
    where: {
      classId_studentId_taskId: {
        classId: schoolClass.id,
        studentId: student.id,
        taskId: task.id,
      },
    },
    update: {
      status,
    },
    create: {
      classId: schoolClass.id,
      studentId: student.id,
      taskId: task.id,
      status,
    },
  });

  // realtime emit
  io.to(`class:${className}`).emit("status-updated", {
    className,
    studentName,
    taskName,
    status: updated.status,
  });

  return {
    ok: true,
    className,
    studentName,
    taskName,
    status: updated.status,
  };
});

// server starten
const port = Number(process.env.PORT || 3001);

await app.ready();

// socket.io setup
io = new Server(app.server, {
  cors: {
    origin: [FRONTEND_ORIGIN],
    methods: ["GET", "POST", "PATCH"],
    credentials: false,
  },
});

io.on("connection", (socket) => {
  socket.on("join-class", (className: string) => {
    socket.join(`class:${className}`);
  });

  socket.on("leave-class", (className: string) => {
    socket.leave(`class:${className}`);
  });
});

await app.listen({
  port,
  host: "0.0.0.0",
});

app.log.info(`NU4P backend draait op http://localhost:${port}`);