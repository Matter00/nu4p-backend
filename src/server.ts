import Fastify from "fastify";
import cors from "@fastify/cors";
import { Server } from "socket.io";
import { z } from "zod";
import { prisma } from "./lib/prisma.js";

const app = Fastify({ logger: true });

const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || "https://q648dn.csb.app";
const ALLOWED_ORIGINS = FRONTEND_ORIGIN.split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

await app.register(cors, {
  origin: ALLOWED_ORIGINS,
  methods: ["GET", "POST", "PATCH", "PUT", "OPTIONS"],
  allowedHeaders: ["Content-Type"],
  credentials: false,
});

app.get("/health", async () => {
  return { ok: true };
});

type StatusValue = "red" | "green" | "orange";

function buildGrid(schoolClass: {
  students: Array<{ id: string; name: string }>;
  tasks: Array<{ id: string; name: string }>;
  taskStatuses: Array<{
    studentId: string;
    taskId: string;
    status: StatusValue;
  }>;
}) {
  const statusMap = new Map(
    schoolClass.taskStatuses.map((taskStatus) => [
      `${taskStatus.studentId}:${taskStatus.taskId}`,
      taskStatus.status,
    ])
  );

  return Object.fromEntries(
    schoolClass.students.map((student) => [
      student.name,
      Object.fromEntries(
        schoolClass.tasks.map((task) => [
          task.name,
          statusMap.get(`${student.id}:${task.id}`) ?? "red",
        ])
      ),
    ])
  );
}

async function getClassesPayload() {
  const classes = await prisma.schoolClass.findMany({
    orderBy: { name: "asc" },
    include: {
      students: { orderBy: { sortOrder: "asc" } },
      tasks: { orderBy: { sortOrder: "asc" } },
      taskStatuses: true,
    },
  });

  return classes.map((schoolClass) => ({
    id: schoolClass.id,
    name: schoolClass.name,
    studentPassword: schoolClass.studentPassword,
    teacherPassword: schoolClass.teacherPassword,

    // Belangrijk: na migratie is dit altijd aanwezig.
    // Voor compatibiliteit met oude frontend krijgt GET /classes dit nu mee.
    statusControlsEnabled: schoolClass.statusControlsEnabled,

    students: schoolClass.students.map((student) => student.name),
    tasks: schoolClass.tasks.map((task) => task.name),
    grid: buildGrid(schoolClass),
  }));
}

app.get("/classes", async () => {
  return getClassesPayload();
});

const updateStatusSchema = z.object({
  className: z.string().trim().min(1),
  studentName: z.string().trim().min(1),
  taskName: z.string().trim().min(1),
  status: z.enum(["red", "green", "orange"]),
});

const addClassSchema = z.object({
  name: z.string().trim().min(1),
  studentPassword: z.string().trim().min(1).default("1234"),
  teacherPassword: z.string().trim().min(1).default("abcd"),
  statusControlsEnabled: z.boolean().optional().default(true),
});

const renameClassSchema = z.object({
  oldName: z.string().trim().min(1),
  newName: z.string().trim().min(1),
});

const saveStudentsSchema = z.object({
  className: z.string().trim().min(1),
  students: z.array(z.string().trim().min(1)),
});

const saveTasksSchema = z.object({
  className: z.string().trim().min(1),
  tasks: z.array(z.string().trim().min(1)),
});

const savePasswordsSchema = z.object({
  className: z.string().trim().min(1),
  studentPassword: z.string().trim().min(1),
  teacherPassword: z.string().trim().min(1),
});

const updateStatusControlsSchema = z.object({
  className: z.string().trim().min(1),
  enabled: z.boolean(),
});

const adminLoginSchema = z.object({
  password: z.string().min(1),
});

let io: Server;

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

  const student = schoolClass.students.find((item) => item.name === studentName);
  if (!student) {
    return reply.status(404).send({ error: "Leerling niet gevonden" });
  }

  const task = schoolClass.tasks.find((item) => item.name === taskName);
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
    update: { status },
    create: {
      classId: schoolClass.id,
      studentId: student.id,
      taskId: task.id,
      status,
    },
  });

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

app.post("/classes", async (request, reply) => {
  const parsed = addClassSchema.safeParse(request.body);

  if (!parsed.success) {
    return reply.status(400).send({
      error: "Ongeldige input",
      details: parsed.error.flatten(),
    });
  }

  const { name, studentPassword, teacherPassword, statusControlsEnabled } = parsed.data;

  const existing = await prisma.schoolClass.findUnique({
    where: { name },
  });

  if (existing) {
    return reply.status(409).send({ error: "Deze klas bestaat al" });
  }

  const createdClass = await prisma.schoolClass.create({
    data: {
      name,
      studentPassword,
      teacherPassword,
      statusControlsEnabled,
    },
  });

  io.emit("status-controls-updated", {
    className: createdClass.name,
    enabled: createdClass.statusControlsEnabled,
  });
  io.emit("classes-changed");

  return {
    ok: true,
    className: createdClass.name,
    statusControlsEnabled: createdClass.statusControlsEnabled,
  };
});

app.patch("/classes/rename", async (request, reply) => {
  const parsed = renameClassSchema.safeParse(request.body);

  if (!parsed.success) {
    return reply.status(400).send({
      error: "Ongeldige input",
      details: parsed.error.flatten(),
    });
  }

  const { oldName, newName } = parsed.data;

  const schoolClass = await prisma.schoolClass.findUnique({
    where: { name: oldName },
  });

  if (!schoolClass) {
    return reply.status(404).send({ error: "Klas niet gevonden" });
  }

  const existing = await prisma.schoolClass.findUnique({
    where: { name: newName },
  });

  if (existing) {
    return reply.status(409).send({ error: "Deze klasnaam bestaat al" });
  }

  await prisma.schoolClass.update({
    where: { name: oldName },
    data: { name: newName },
  });

  io.emit("classes-changed");
  return { ok: true };
});

app.put("/classes/students", async (request, reply) => {
  const parsed = saveStudentsSchema.safeParse(request.body);

  if (!parsed.success) {
    return reply.status(400).send({
      error: "Ongeldige input",
      details: parsed.error.flatten(),
    });
  }

  const { className, students } = parsed.data;

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

  const trimmedStudents = [...new Set(students.map((student) => student.trim()).filter(Boolean))];
  const existingStudents = schoolClass.students;

  const studentsToDelete = existingStudents.filter(
    (student) => !trimmedStudents.includes(student.name)
  );

  await prisma.$transaction(async (tx) => {
    for (const student of studentsToDelete) {
      await tx.taskStatus.deleteMany({
        where: {
          classId: schoolClass.id,
          studentId: student.id,
        },
      });

      await tx.student.delete({
        where: { id: student.id },
      });
    }

    for (const [index, studentName] of trimmedStudents.entries()) {
      const existingStudent = existingStudents.find((student) => student.name === studentName);

      if (existingStudent) {
        await tx.student.update({
          where: { id: existingStudent.id },
          data: { sortOrder: index },
        });
        continue;
      }

      const newStudent = await tx.student.create({
        data: {
          name: studentName,
          classId: schoolClass.id,
          sortOrder: index,
        },
      });

      for (const task of schoolClass.tasks) {
        await tx.taskStatus.create({
          data: {
            classId: schoolClass.id,
            studentId: newStudent.id,
            taskId: task.id,
            status: "red",
          },
        });
      }
    }
  });

  io.emit("classes-changed");
  return { ok: true };
});

app.put("/classes/tasks", async (request, reply) => {
  const parsed = saveTasksSchema.safeParse(request.body);

  if (!parsed.success) {
    return reply.status(400).send({
      error: "Ongeldige input",
      details: parsed.error.flatten(),
    });
  }

  const { className, tasks } = parsed.data;

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

  const trimmedTasks = [...new Set(tasks.map((task) => task.trim()).filter(Boolean))];
  const existingTasks = schoolClass.tasks;

  const tasksToDelete = existingTasks.filter(
    (task) => !trimmedTasks.includes(task.name)
  );

  await prisma.$transaction(async (tx) => {
    for (const task of tasksToDelete) {
      await tx.taskStatus.deleteMany({
        where: {
          classId: schoolClass.id,
          taskId: task.id,
        },
      });

      await tx.task.delete({
        where: { id: task.id },
      });
    }

    for (const [index, taskName] of trimmedTasks.entries()) {
      const existingTask = existingTasks.find((task) => task.name === taskName);

      if (existingTask) {
        await tx.task.update({
          where: { id: existingTask.id },
          data: { sortOrder: index },
        });
        continue;
      }

      const newTask = await tx.task.create({
        data: {
          name: taskName,
          classId: schoolClass.id,
          sortOrder: index,
        },
      });

      for (const student of schoolClass.students) {
        await tx.taskStatus.create({
          data: {
            classId: schoolClass.id,
            studentId: student.id,
            taskId: newTask.id,
            status: "red",
          },
        });
      }
    }
  });

  io.emit("classes-changed");
  return { ok: true };
});

app.put("/classes/passwords", async (request, reply) => {
  const parsed = savePasswordsSchema.safeParse(request.body);

  if (!parsed.success) {
    return reply.status(400).send({
      error: "Ongeldige input",
      details: parsed.error.flatten(),
    });
  }

  const { className, studentPassword, teacherPassword } = parsed.data;

  const schoolClass = await prisma.schoolClass.findUnique({
    where: { name: className },
  });

  if (!schoolClass) {
    return reply.status(404).send({ error: "Klas niet gevonden" });
  }

  await prisma.schoolClass.update({
    where: { name: className },
    data: {
      studentPassword,
      teacherPassword,
    },
  });

  io.emit("classes-changed");
  return { ok: true };
});

app.patch("/classes/status-controls", async (request, reply) => {
  const parsed = updateStatusControlsSchema.safeParse(request.body);

  if (!parsed.success) {
    return reply.status(400).send({
      error: "Ongeldige input",
      details: parsed.error.flatten(),
    });
  }

  const { className, enabled } = parsed.data;

  const schoolClass = await prisma.schoolClass.findUnique({
    where: { name: className },
  });

  if (!schoolClass) {
    return reply.status(404).send({ error: "Klas niet gevonden" });
  }

  const updatedClass = await prisma.schoolClass.update({
    where: { name: className },
    data: {
      statusControlsEnabled: enabled,
    },
    select: {
      id: true,
      name: true,
      statusControlsEnabled: true,
    },
  });

  const payload = {
    className: updatedClass.name,
    enabled: updatedClass.statusControlsEnabled,
  };

  io.to(`class:${updatedClass.name}`).emit("status-controls-updated", payload);
  io.emit("status-controls-updated", payload);
  io.emit("classes-changed");

  return {
    ok: true,
    class: updatedClass,
  };
});

app.post("/auth/admin-login", async (request, reply) => {
  const parsed = adminLoginSchema.safeParse(request.body);

  if (!parsed.success) {
    return reply.status(400).send({
      error: "Ongeldige input",
      details: parsed.error.flatten(),
    });
  }

  const { password } = parsed.data;

  const adminPassword = process.env.ADMIN_PASSWORD;

  if (!adminPassword) {
    return reply.status(500).send({ error: "ADMIN_PASSWORD ontbreekt op de server" });
  }

  if (password !== adminPassword) {
    return reply.status(401).send({ error: "Fout wachtwoord" });
  }

  return { ok: true };
});

const port = Number(process.env.PORT || 3001);

await app.ready();

io = new Server(app.server, {
  cors: {
    origin: ALLOWED_ORIGINS,
    methods: ["GET", "POST", "PATCH", "PUT"],
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